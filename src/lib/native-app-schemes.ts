// Custom URI schemes (e.g. "filament://") native apps register as deep links,
// allowed as a `returnTo` target for /native-oauth-bridge. Required in any
// environment that needs the OAuth-for-native handoff — there's no safe
// generic default, since accepting an arbitrary returnTo would hand a live
// one-time-token to whatever URL an attacker supplies.
export const nativeAppSchemes = process.env.NATIVE_APP_SCHEMES
  ? process.env.NATIVE_APP_SCHEMES.split(',')
      .map((scheme) => scheme.trim())
      .filter(Boolean)
  : []
