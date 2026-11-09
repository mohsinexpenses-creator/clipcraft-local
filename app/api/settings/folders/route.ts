import { NextRequest, NextResponse } from "next/server";
import { toErrorMessage, toErrorStatus } from "@/lib/errors";
import {
  assertLocalFolderBrowserRequest,
  createFolder,
  listFolders,
} from "@/lib/folder-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/settings/folders?path=/chosen/folder
 *
 * The folder browser is intentionally local-only: selecting a path controls
 * where the local worker can write uploads, frames, fonts, and renders. It lists
 * directories only and accepts no shell syntax or file selection.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertLocalFolderBrowserRequest(request);
    const selected = request.nextUrl.searchParams.get("path") ?? undefined;
    return NextResponse.json(listFolders(selected));
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, "Could not browse that folder.") },
      { status: toErrorStatus(error, 400) },
    );
  }
}

/**
 * POST /api/settings/folders { parent, name }
 *
 * Creates exactly one child directory under the folder the user is already
 * viewing. This keeps folder creation auditable and avoids accepting an
 * unbounded path expression from the browser.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertLocalFolderBrowserRequest(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(createFolder(body.parent, body.name), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, "Could not create that folder.") },
      { status: toErrorStatus(error, 400) },
    );
  }
}
