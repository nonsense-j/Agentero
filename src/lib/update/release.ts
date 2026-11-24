/** Match the versioned tags published by the desktop release workflow. */
export function getUpdateReleaseUrl(version?: string): string {
	const releases = "https://github.com/nonsense-j/Dovero/releases";
	return version
		? `${releases}/tag/${encodeURIComponent(`v${version}`)}`
		: `${releases}/latest`;
}
