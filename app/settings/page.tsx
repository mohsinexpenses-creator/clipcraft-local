import React from "react";
import { SettingsWorkspace } from "@/components/settings/settings-workspace";

export const metadata = { title: "Settings" };

/**
 * Defaults for the automatic pipeline and the render, provider keys, worker limits and
 * the profanity policy - everything that used to mean editing `.env.local` and
 * restarting. Server-side values keep their documented priority: Settings, then the
 * env file, then the built-in default.
 */
export default function SettingsPage() {
  return <SettingsWorkspace />;
}
