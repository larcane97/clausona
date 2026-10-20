/**
 * Whether a sign-in landed on a different account than the one registered. Codex records
 * the account id instead of an email when its id_token carries none, so only values of
 * the same form are compared: two emails case-insensitively, two ids exactly. An email
 * against an id could be the same account and is not reported.
 */
export function isOtherAccount(registered: string, signedInAs: string): boolean {
  const isEmail = registered.includes("@");
  if (isEmail !== signedInAs.includes("@")) return false;
  return isEmail ? signedInAs.toLowerCase() !== registered.toLowerCase() : signedInAs !== registered;
}
