/** Establish native OMP identity before loading the shared CLI. */
export function activateNativeProduct(): void {
	process.env.BREADBOARD_PRODUCT = "0";
}
