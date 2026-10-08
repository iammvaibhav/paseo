import { useCallback, useMemo } from "react";
import { usePanelStore } from "@/stores/panel-store";
import { resolveSelectedSubmoduleForCheckout } from "@/stores/explorer-submodule-memory";
import { findSubmodule, useSubmodulesQuery } from "./use-submodules-query";

/**
 * Shared submodule context for the explorer surfaces (sidebar header picker
 * and the workspace Changes pane). The selected submodule is remembered per
 * checkout in the panel store, so every git surface rooted at the checkout
 * follows the same selection.
 */
export function useSubmoduleContext({
  serverId,
  workspaceRoot,
  isGit,
  enabled,
}: {
  serverId: string;
  workspaceRoot: string;
  isGit: boolean;
  enabled: boolean;
}) {
  const storedSubmodule = usePanelStore((state) =>
    resolveSelectedSubmoduleForCheckout({
      serverId,
      cwd: workspaceRoot,
      selectedSubmoduleByCheckout: state.selectedSubmoduleByCheckout,
    }),
  );
  const setSelectedSubmoduleForCheckout = usePanelStore(
    (state) => state.setSelectedSubmoduleForCheckout,
  );
  const { submodules, hasSubmodules, isResolved } = useSubmodulesQuery({
    serverId,
    cwd: workspaceRoot,
    enabled: isGit && enabled,
  });
  // The remembered submodule survives until the checkout proves it is gone;
  // holding it through the initial fetch avoids a root -> submodule flip that
  // would make the diff and PR panes fetch the superproject first.
  const selectedSubmodule =
    storedSubmodule && isResolved && !findSubmodule(submodules, storedSubmodule)
      ? null
      : storedSubmodule;
  const setSelectedSubmodule = useCallback(
    (submodulePath: string | null) => {
      setSelectedSubmoduleForCheckout({ serverId, cwd: workspaceRoot, submodulePath });
    },
    [serverId, setSelectedSubmoduleForCheckout, workspaceRoot],
  );
  const effectiveCwd = useMemo(
    () => (selectedSubmodule ? `${workspaceRoot}/${selectedSubmodule}` : workspaceRoot),
    [workspaceRoot, selectedSubmodule],
  );
  return { effectiveCwd, submodules, hasSubmodules, selectedSubmodule, setSelectedSubmodule };
}
