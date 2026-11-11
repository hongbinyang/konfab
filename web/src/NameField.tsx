import { nameRule, suggestName, validName } from "./name-validation";

export function NameField({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const invalid = !validName(value);
  const suggestion = suggestName(value);
  return (
    <div>
      <label>
        {label}
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          aria-invalid={value !== "" && invalid}
        />
      </label>
      <small>{nameRule}</small>
      {value !== "" && invalid && suggestion && suggestion !== value && (
        <button type="button" onClick={() => onChange(suggestion)}>
          Use {suggestion}
        </button>
      )}
    </div>
  );
}
