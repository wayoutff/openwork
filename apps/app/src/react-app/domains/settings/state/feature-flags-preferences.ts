import { useCallback } from "react";

import { useLocal } from "../../../kernel/local-provider";

export function useFeatureFlagsPreferences() {
  const { prefs, setPrefs } = useLocal();

  const workspaceRunModeEnabled = prefs.featureFlags?.workspaceRunMode === true;
  const gitChangesPanelEnabled = prefs.featureFlags?.gitChangesPanel === true;
  const sessionFileBrowserEnabled = prefs.featureFlags?.sessionFileBrowser === true;
  const localComputerUseEnabled = prefs.featureFlags?.localComputerUse === true;
  const toggleLocalComputerUse = () => setPrefs((previous) => ({
    ...previous, featureFlags: { ...previous.featureFlags, localComputerUse: !previous.featureFlags?.localComputerUse },
  }));
  const toggleSessionFileBrowser = () => setPrefs((previous) => ({
    ...previous,
    featureFlags: { ...previous.featureFlags, sessionFileBrowser: !previous.featureFlags?.sessionFileBrowser },
  }));
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
    sessionFileBrowserEnabled,
    toggleSessionFileBrowser,
    localComputerUseEnabled,
    toggleLocalComputerUse,
  };
}
