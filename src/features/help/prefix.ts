/** The first configured command prefix (`COMMAND_PREFIX`) from the client options, or `?`. */
export function commandPrefix(configured: string | readonly string[] | undefined | null): string {
  return (Array.isArray(configured) ? configured[0] : (configured as string | undefined)) ?? '?';
}
