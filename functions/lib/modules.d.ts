declare module 'country-iso-2-to-3' {
  // ISO 3166-1 alpha-2 → alpha-3, undefined for unknown codes
  export default function getCountryISO3(code: string): string | undefined;
}
