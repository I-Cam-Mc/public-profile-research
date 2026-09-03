function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  const persisted = JSON.stringify(value);
  if (persisted === undefined) {
    throw new TypeError("Canonical JSON requires a JSON-persistable root value");
  }
  return JSON.stringify(sortJsonValue(JSON.parse(persisted)));
}
