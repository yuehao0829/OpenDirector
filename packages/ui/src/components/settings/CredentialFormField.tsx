import { useState, useRef } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface CredentialFormFieldProps {
  label: string;
  fieldKey: string;
  value: string;
  onChange: (key: string, value: string) => void;
  type?: 'text' | 'url' | 'password' | 'hidden' | 'select';
  options?: Array<{ value: string; label: string }>;
  /** When true, show password dots instead of value; clear on focus; hide eye toggle until edited */
  masked?: boolean;
  /** When true and masked, show mask even if value is empty (e.g. credential stored in .enc file) */
  configured?: boolean;
  placeholder?: string;
  description?: string;
  required?: boolean;
  size?: 'sm' | 'xs';
}

export function CredentialFormField({
  label,
  fieldKey,
  value,
  onChange,
  type = 'password',
  options,
  masked = false,
  configured = false,
  placeholder,
  description,
  required,
  size = 'sm',
}: CredentialFormFieldProps) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const [edited, setEdited] = useState(false);
  const savedOriginalRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  const isPassword = type === 'password';
  const isSelect = type === 'select';

  // masked mode: show bullet dots for existing value (not yet edited)
  const showMask = masked && isPassword && !edited && !focused && (configured || !!value);

  // Show the eye toggle button:
  // - Not masked mode: always show (add flow)
  // - Masked mode: only show after user has focused or edited
  const showEyeToggle = isPassword && (!masked || focused || edited);

  const handleFocus = () => {
    if (showMask) {
      savedOriginalRef.current = value;
      onChange(fieldKey, '');
    }
    setFocused(true);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEdited(true);
    onChange(fieldKey, e.target.value);
  };

  const handleBlur = () => {
    setFocused(false);
    // User focused (cleared value) but didn't type anything — restore original to re-enter mask
    if (masked && !edited && !value) {
      onChange(fieldKey, savedOriginalRef.current);
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <label className={`font-medium ${size === 'xs' ? 'text-xs text-zinc-400' : 'text-sm text-zinc-300'}`}>
          {label}
          {required && <span className="text-red-400 ml-0.5">*</span>}
        </label>
      </div>
      {description && (
        <p className={`${size === 'xs' ? 'text-[11px]' : 'text-xs'} text-zinc-500`}>{description}</p>
      )}
      {isSelect ? (
        <select
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {options?.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ) : (
        <div className="relative">
          <input
            ref={inputRef}
            type={showMask ? 'password' : (isPassword ? (visible ? 'text' : 'password') : 'text')}
            value={showMask ? '•'.repeat(30) : value}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder={showMask ? undefined : placeholder}
            readOnly={showMask}
            className={
              isPassword
                ? 'w-full px-3 py-2 pr-9 rounded-lg border border-zinc-700 bg-zinc-800 text-white placeholder-zinc-500 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 [&::-ms-reveal]:hidden [&::-webkit-credentials-auto-fill-button]:hidden'
                : 'w-full px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 text-white placeholder-zinc-500 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500'
            }
          />
          {showEyeToggle && (
            <button
              type="button"
              onClick={() => setVisible(!visible)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              {visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
