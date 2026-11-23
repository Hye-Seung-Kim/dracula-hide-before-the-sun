/**
 * Reload the page when the server reports a new build, so a laptop/phone tab can never keep running stale code
 * after an update. `canReload()` lets the page postpone it (e.g. during a reveal).
 */
export function autoReloadOnNewBuild(canReload: () => boolean = () => true, onBeforeReload: () => void = () => {}) {
  let mine: string | null = null;
  const check = async () => {
    try {
      const r = await fetch("/api/version", { cache: "no-store" });
      const { version } = (await r.json()) as { version: string };
      if (version === "dev" || version === "unknown") return;
      if (mine === null) mine = version;
      else if (version !== mine && canReload()) {
        onBeforeReload();
        location.reload();
      }
    } catch {
      /* server restarting */
    }
  };
  void check();
  setInterval(check, 4000);
}
