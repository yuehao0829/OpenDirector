use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const PBKDF2_ITERATIONS: u32 = 100_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EncryptedPayload {
    pub ciphertext: String, // base64 (includes GCM auth tag)
    pub iv: String,         // base64, 12 bytes
    pub salt: String,       // base64, 32 bytes
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/// Derive a 256-bit key from password and raw salt using PBKDF2-SHA256.
pub fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    key
}

/// Generate a random 32-byte salt, derive a key, return (base64_salt, key).
pub fn generate_and_derive(password: &str) -> (String, [u8; 32]) {
    let mut salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);
    use base64::Engine;
    let salt_b64 = base64::engine::general_purpose::STANDARD.encode(&salt);
    let key = derive_key(password, &salt);
    (salt_b64, key)
}

/// Derive key from password and base64-encoded salt.
pub fn derive_key_from_b64(password: &str, salt_b64: &str) -> Result<[u8; 32], String> {
    use base64::Engine;
    let salt = base64::engine::general_purpose::STANDARD
        .decode(salt_b64)
        .map_err(|e| format!("Invalid salt: {}", e))?;
    Ok(derive_key(password, &salt))
}

// ---------------------------------------------------------------------------
// High-level encrypt / decrypt (with PBKDF2 key derivation)
// ---------------------------------------------------------------------------

/// Encrypt plaintext with a password using AES-256-GCM.
/// Key is derived via PBKDF2-SHA256 with a random 32-byte salt.
pub fn encrypt(plaintext: &[u8], password: &str) -> Result<EncryptedPayload, String> {
    let (salt_b64, key) = generate_and_derive(password);
    let mut payload = encrypt_with_key(&key, plaintext)?;
    payload.salt = salt_b64;
    Ok(payload)
}

/// Decrypt ciphertext with a password.
pub fn decrypt(encrypted: &EncryptedPayload, password: &str) -> Result<Vec<u8>, String> {
    let key = derive_key_from_b64(password, &encrypted.salt)?;
    decrypt_with_key(&key, encrypted)
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt with pre-derived key (no PBKDF2 overhead)
// ---------------------------------------------------------------------------

/// Encrypt with a pre-derived key (no PBKDF2 overhead).
/// Returns EncryptedPayload with empty salt field — caller is responsible for
/// setting `salt` if the payload will be consumed by password-based `decrypt`.
pub fn encrypt_with_key(key: &[u8], plaintext: &[u8]) -> Result<EncryptedPayload, String> {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&iv);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| e.to_string())?;

    use base64::Engine;
    Ok(EncryptedPayload {
        ciphertext: base64::engine::general_purpose::STANDARD.encode(&ciphertext),
        iv: base64::engine::general_purpose::STANDARD.encode(&iv),
        salt: String::new(),
    })
}

/// Decrypt with a pre-derived key (no PBKDF2 overhead).
pub fn decrypt_with_key(key: &[u8], encrypted: &EncryptedPayload) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&encrypted.ciphertext)
        .map_err(|e| e.to_string())?;
    let iv = base64::engine::general_purpose::STANDARD
        .decode(&encrypted.iv)
        .map_err(|e| e.to_string())?;

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&iv);
    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Decryption failed: wrong password or corrupted data".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let plaintext = b"Hello, OpenDirector!";
        let password = "test-password-123";

        let encrypted = encrypt(plaintext, password).unwrap();
        let decrypted = decrypt(&encrypted, password).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn wrong_password_fails() {
        let plaintext = b"secret data";
        let encrypted = encrypt(plaintext, "correct-password").unwrap();

        let result = decrypt(&encrypted, "wrong-password");
        assert!(result.is_err());
    }

    #[test]
    fn different_salts_produce_different_ciphertexts() {
        let plaintext = b"same plaintext";
        let password = "same-password";

        let encrypted1 = encrypt(plaintext, password).unwrap();
        let encrypted2 = encrypt(plaintext, password).unwrap();

        assert_ne!(encrypted1.ciphertext, encrypted2.ciphertext);
        assert_ne!(encrypted1.salt, encrypted2.salt);
    }

    #[test]
    fn shared_key_roundtrip() {
        let plaintext = b"shared key test";
        let password = "shared-password";
        let (salt_b64, key) = generate_and_derive(password);

        let mut encrypted = encrypt_with_key(&key, plaintext).unwrap();
        encrypted.salt = salt_b64.clone(); // backward compat: old importers can still decrypt

        // Derive same key from salt (what old importers would do)
        let key2 = derive_key_from_b64(password, &salt_b64).unwrap();
        let decrypted = decrypt_with_key(&key2, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);

        // Old code path: decrypt with password (uses per-entry salt, same salt → same key)
        let decrypted_old = decrypt(&encrypted, password).unwrap();
        assert_eq!(decrypted_old, plaintext);
    }

    #[test]
    fn large_payload() {
        let plaintext = vec![0u8; 1024 * 1024]; // 1 MB
        let password = "large-test-password";

        let encrypted = encrypt(&plaintext, password).unwrap();
        let decrypted = decrypt(&encrypted, password).unwrap();

        assert_eq!(decrypted.len(), plaintext.len());
        assert_eq!(decrypted, plaintext);
    }
}
