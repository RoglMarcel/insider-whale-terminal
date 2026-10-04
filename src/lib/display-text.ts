/** Presentation only: stored research notes stay intact; decorative emoji do not render. */
export function displayText(value: string): string {
  return value
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\uFE0E\u200D\u20E3]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
