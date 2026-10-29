import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useServer } from "@/react-app/kernel/server-provider";
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations";
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature";
import { resolveLocalGitChanges } from "./git-changes-feature";

export function useGitChangesFeature(): boolean {
  const { prefs } = useLocal();
  const server = useServer();
  const context = useAutomationsDenContext();
  const managed = useOrgFeature("gitChangesPanel", { active: context.ready });
  return context.ready ? managed : resolveLocalGitChanges(
    prefs.featureFlags?.gitChangesPanel === true,
    server.url,
    isDesktopRuntime(),
    context.ready,
  );
}
