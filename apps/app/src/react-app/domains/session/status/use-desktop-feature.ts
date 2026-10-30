import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useOrgFeatureState } from "@/react-app/domains/cloud/use-org-feature"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { desktopBridge } from "@/app/lib/desktop"
import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { useLocal } from "@/react-app/kernel/local-provider"
import { useServer } from "@/react-app/kernel/server-provider"
import { resolveLocalComputerFeature } from "./local-computer-feature"

const FEATURE_STALE_MS = 30_000

type DesktopFeatureKey = "computerUse" | "computerUseBackground" | "computerKeepFront" | "browserFloatingView" | "remoteComputers" | "mermaidZoom" | "providerCredentialStatus" | "desktopUpdateDownloadWindow" | "settledSessions" | "libraryDetailBreadcrumbs"

/**
 * Reads one desktop feature from the registry. Signed in, it follows the
 * active organization through the shared org-feature hook; signed out, the
 * deployment switch (`GET /v1/features`). Unreachable or missing means off.
 */
export function useDesktopFeature(key: DesktopFeatureKey): boolean {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const { prefs } = useLocal()
  const server = useServer()
  const computerKey = ["computerUse", "computerUseBackground", "remoteComputers"].includes(key)
  const localHost = useQuery({
    queryKey: ["desktop", "local-computer-profile"],
    queryFn: () => desktopBridge.computerLocalProfile(),
    enabled: isDesktopRuntime() && computerKey,
    staleTime: Infinity,
    retry: false,
  })
  const localMode = computerKey && localHost.data === true && !context.ready && denAuth.status === "signed_out"
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
  // Not desktopOnly: the web app shows the cloud computer from these flags too.
  const organization = useOrgFeatureState(key)
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => deploymentClient.getDeploymentFeatures(),
    enabled: !context.ready && denAuth.status === "signed_out" && !localMode,
    staleTime: FEATURE_STALE_MS,
    refetchInterval: FEATURE_STALE_MS,
    refetchIntervalInBackground: true,
    retry: false,
    select: (features) => features[key] === true,
  })
  if (localMode) return resolveLocalComputerFeature({
    hostEligible: true, optedIn: prefs.featureFlags?.localComputerUse === true,
    signedOut: true, organizationReady: false, serverUrl: server.url, key,
  })
  // Do not briefly enable cloud defaults before the local host check settles.
  if (computerKey && isDesktopRuntime() && !context.ready && (localHost.isPending || localHost.isError)) return false
  return context.ready ? organization.enabled : denAuth.status === "signed_out" && !deployment.isError && deployment.data === true
}
