use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::provider_key::get_credentials_internal;

// ---------------------------------------------------------------------------
// Minimal AsyncRuntime impl for ve-tos-rust-sdk (backed by tokio)
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct TokioAsyncRuntime;

#[async_trait]
impl ve_tos_rust_sdk::asynchronous::tos::AsyncRuntime for TokioAsyncRuntime {
    type JoinError = tokio::task::JoinError;

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }

    fn spawn<'a, F>(
        &self,
        future: F,
    ) -> Pin<Box<dyn Future<Output = Result<F::Output, Self::JoinError>> + Send + 'a>>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        Box::pin(tokio::spawn(future))
    }

    fn block_on<F: Future>(&self, future: F) -> F::Output {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(future)),
            Err(_) => {
                let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
                rt.block_on(future)
            }
        }
    }
}

// Type alias for the TOS async client we'll use throughout
type TosAsyncClient = ve_tos_rust_sdk::asynchronous::tos::TosClientImpl<
    ve_tos_rust_sdk::credential::CommonCredentialsProvider<
        ve_tos_rust_sdk::credential::CommonCredentials,
    >,
    ve_tos_rust_sdk::credential::CommonCredentials,
    TokioAsyncRuntime,
>;

// ---------------------------------------------------------------------------
// TOS params
// ---------------------------------------------------------------------------

pub(crate) struct TosParams {
    pub ak: String,
    pub sk: String,
    pub bucket: String,
    pub endpoint: String,
    pub region: String,
}

pub(crate) fn get_tos_params(
    creds: &super::provider_key::Credentials,
) -> Result<TosParams, String> {
    let endpoint = creds
        .tos_endpoint
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "TOS not configured for this provider (missing tos_endpoint)".to_string())?;
    let bucket = creds
        .tos_bucket
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "TOS not configured for this provider (missing tos_bucket)".to_string())?;

    Ok(TosParams {
        ak: creds.ak.clone(),
        sk: creds.sk.clone(),
        bucket: bucket.to_string(),
        endpoint: endpoint.to_string(),
        region: creds.region.clone(),
    })
}

// ---------------------------------------------------------------------------
// TOS client builder helper
// ---------------------------------------------------------------------------

fn build_tos_client(params: &TosParams) -> Result<TosAsyncClient, String> {
    use ve_tos_rust_sdk::asynchronous::tos::builder;

    let region = if params.region.is_empty() {
        super::util::DEFAULT_REGION
    } else {
        params.region.as_str()
    };

    builder::<TokioAsyncRuntime>()
        .ak(&params.ak)
        .sk(&params.sk)
        .endpoint(&params.endpoint)
        .region(region)
        .build()
        .map_err(|e| format!("Failed to build TOS client: {}", e))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn build_tos_object_url(params: &TosParams, bucket: &str, key: &str) -> String {
    let endpoint_host = super::util::strip_url_scheme(&params.endpoint);
    format!(
        "https://{}.{}.{}/{}",
        bucket, params.region, endpoint_host, key
    )
}

async fn tos_presign_get_url(
    client: &TosAsyncClient,
    bucket: &str,
    key: &str,
    expiration_seconds: i64,
) -> Result<String, String> {
    use ve_tos_rust_sdk::asynchronous::auth::SignerAPI;

    let mut input = ve_tos_rust_sdk::auth::PreSignedURLInput::new(bucket);
    input.set_key(key);
    input.set_expires(expiration_seconds);

    client
        .pre_signed_url(&input)
        .await
        .map(|o| o.signed_url().to_string())
        .map_err(|e| format!("Failed to generate presigned URL: {}", e))
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TOSValidationResult {
    pub valid: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Validate TOS credentials by performing a HeadBucket check.
#[tauri::command]
pub async fn validate_tos_credentials(
    ak: String,
    sk: String,
    bucket: String,
    endpoint: String,
    region: String,
) -> Result<TOSValidationResult, String> {
    let params = TosParams {
        ak,
        sk,
        bucket: bucket.clone(),
        endpoint,
        region,
    };

    match build_tos_client(&params) {
        Ok(client) => {
            use ve_tos_rust_sdk::asynchronous::bucket::BucketAPI;
            let input = ve_tos_rust_sdk::bucket::HeadBucketInput::new(&bucket);
            match client.head_bucket(&input).await {
                Ok(_) => Ok(TOSValidationResult {
                    valid: true,
                    message: "Bucket accessible".to_string(),
                }),
                Err(e) => Ok(TOSValidationResult {
                    valid: false,
                    message: format!("Bucket access failed: {}", e),
                }),
            }
        }
        Err(e) => Ok(TOSValidationResult {
            valid: false,
            message: format!("Failed to build TOS client: {}", e),
        }),
    }
}

// ---------------------------------------------------------------------------
// Presign / delete commands
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TOSPresignResult {
    pub url: String,
    pub expires_at: String,
}

#[tauri::command]
pub async fn tos_presign_url(
    provider_id: String,
    password: String,
    bucket: String,
    key: String,
    expires_seconds: i64,
) -> Result<TOSPresignResult, String> {
    let creds = get_credentials_internal(&provider_id, &password)?;
    let params = get_tos_params(&creds)?;

    let bucket = if bucket.is_empty() {
        params.bucket.clone()
    } else {
        bucket
    };
    let max_expires = 604800i64; // 7 days
    let expires = if expires_seconds <= 0 {
        3600
    } else if expires_seconds > max_expires {
        max_expires
    } else {
        expires_seconds
    };

    let client = build_tos_client(&params)?;

    use ve_tos_rust_sdk::asynchronous::auth::SignerAPI;

    let mut input = ve_tos_rust_sdk::auth::PreSignedURLInput::new(&bucket);
    input.set_key(&key);
    input.set_expires(expires);

    match client.pre_signed_url(&input).await {
        Ok(output) => {
            use chrono::Utc;
            let expires_at = Utc::now() + chrono::Duration::seconds(expires);
            Ok(TOSPresignResult {
                url: output.signed_url().to_string(),
                expires_at: expires_at.to_rfc3339(),
            })
        }
        Err(e) => Err(format!("Failed to generate presigned URL: {}", e)),
    }
}

#[tauri::command]
pub async fn tos_delete_object(
    provider_id: String,
    password: String,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let creds = get_credentials_internal(&provider_id, &password)?;
    let params = get_tos_params(&creds)?;

    let bucket = if bucket.is_empty() {
        params.bucket.clone()
    } else {
        bucket
    };
    let client = build_tos_client(&params)?;

    use ve_tos_rust_sdk::asynchronous::object::ObjectAPI;

    let input = ve_tos_rust_sdk::object::DeleteObjectInput::new(&bucket, &key);

    client
        .delete_object(&input)
        .await
        .map_err(|e| format!("Failed to delete TOS object: {}", e))?;

    Ok(())
}

const MAX_UPLOAD_SIZE: u64 = 50 * 1024 * 1024;
const PRESIGNED_URL_TTL_SECS: i64 = 3600;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TOSFileUploadResult {
    pub object_key: String,
    pub url: String,
    pub presigned_url: String,
    pub expires_at: String,
    pub file_size: u64,
    pub content_type: String,
    pub skipped: bool,
}

/// Internal TOS upload function — can be called from other Rust modules.
pub(crate) async fn tos_upload_internal(
    params: &TosParams,
    file_path: &std::path::Path,
) -> Result<TOSFileUploadResult, String> {
    let canonical = super::util::validate_local_path(&file_path.to_string_lossy())?;

    let file_size = std::fs::metadata(&canonical)
        .map_err(|e| format!("Cannot read file metadata: {}", e))?
        .len();
    if file_size > MAX_UPLOAD_SIZE {
        return Err("File size exceeds 50MB limit".to_string());
    }

    let content_type =
        crate::commands::seedance_api::infer_content_type(&file_path.to_string_lossy());

    let hash = crate::commands::seedance_api::sha256_hex_file(&canonical)?;
    let object_key = format!("uploads/{}", hash);

    let client = build_tos_client(params)?;
    use ve_tos_rust_sdk::asynchronous::object::ObjectAPI;

    // Skip upload when the object key already exists (caller ensures keys are content-addressed)
    let already_exists = client
        .does_object_exist(&ve_tos_rust_sdk::object::DoesObjectExistInput::new(
            &params.bucket,
            &object_key,
        ))
        .await
        .unwrap_or(false);

    if !already_exists {
        let mut input = ve_tos_rust_sdk::object::PutObjectFromFileInput::new_with_file_path(
            &params.bucket,
            &object_key,
            canonical.to_str().ok_or("Invalid file path")?,
        );
        input.set_content_type(content_type);

        client
            .put_object_from_file(&input)
            .await
            .map_err(|e| format!("TOS upload failed: {}", e))?;
    }

    let url = build_tos_object_url(params, &params.bucket, &object_key);
    let presigned_url =
        tos_presign_get_url(&client, &params.bucket, &object_key, PRESIGNED_URL_TTL_SECS).await?;

    use chrono::Utc;
    let expires_at = (Utc::now() + chrono::Duration::seconds(PRESIGNED_URL_TTL_SECS)).to_rfc3339();

    Ok(TOSFileUploadResult {
        object_key,
        url,
        presigned_url,
        expires_at,
        file_size,
        content_type: content_type.to_string(),
        skipped: already_exists,
    })
}

#[tauri::command]
pub async fn tos_upload_local_file(
    provider_id: String,
    password: String,
    file_path: String,
) -> Result<TOSFileUploadResult, String> {
    let creds = get_credentials_internal(&provider_id, &password)?;
    let params = get_tos_params(&creds)?;

    tos_upload_internal(&params, std::path::Path::new(&file_path)).await
}
