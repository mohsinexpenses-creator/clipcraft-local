import React from "react";
import { SettingsWorkspace } from "@/components/settings/settings-workspace";

export const metadata = { title: "Settings" };

/**
 * Defaults for the automatic pipeline and the render, provider keys, worker limits and
 * the profanity policy - everything that used to mean editing `.env.local` and
 * restarting. This page is the source of truth for those values: what is saved here,
 * otherwise the built-in default. `.env.local` is not consulted for them at run time.
 */
export default function SettingsPage() {
  return <SettingsWorkspace />;
}
