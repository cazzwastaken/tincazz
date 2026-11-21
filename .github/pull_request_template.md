<!-- Read CONTRIBUTING.md first. Use a Conventional Commits title, e.g. feat(economy): add weekly claim -->

## Summary

<!-- What does this change and why? -->

Closes #

## Screenshots

<!-- New or changed cards and messages. Delete if not applicable. -->

## Deploy notes

<!-- Anything needed before this reaches main: new intent or permission, .env variable,
docker-compose.yml change. Write "None" if nothing. -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` passes
- [ ] Tests cover the new behavior or the fix
- [ ] Schema changes come with a generated migration in `drizzle/`
- [ ] New environment variables are in `src/config/env.ts` and `.env.example`
- [ ] README, `/help`, `docs/games.md` and AGENTS.md updated if behavior, rules or conventions changed
- [ ] No secrets, tokens or private IDs in the diff
