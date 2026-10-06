export function implementationCommitOf(env: NodeJS.ProcessEnv): string | null {
  const sha = env.GITHUB_SHA;
  return sha === undefined || sha === "" ? null : sha;
}
