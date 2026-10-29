import { useCallback } from "react";

import { useLocal } from "../../../kernel/local-provider";

export function useFeatureFlagsPreferences() {
  const { prefs, setPrefs } = useLocal();

  const workspaceRunModeEnabled = prefs.featureFlags?.workspaceRunMode === true;
  const gitChangesPanelEnabled = prefs.featureFlags?.gitChangesPanel === true;
  const toggleGitChangesPanel = () => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        gitChangesPanel: !previous.featureFlags?.gitChangesPanel,
      },
    }));
  };
  const toggleWorkspaceRunMode = useCallback(() => {
    setPrefs((previous) => ({
      ...previous,
      featureFlags: {
        ...previous.featureFlags,
        workspaceRunMode: !previous.featureFlags?.workspaceRunMode,
      },
    }));
  }, [setPrefs]);

  return {
    workspaceRunModeEnabled,
    toggleWorkspaceRunMode,
    gitChangesPanelEnabled,
    toggleGitChangesPanel,
  };
}
