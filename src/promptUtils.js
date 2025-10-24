export function sanitizePrompt(input) {
  if (typeof input !== 'string') {
    return input;
  }
  return input.replace(/\r?\n/g, ' ');
}
