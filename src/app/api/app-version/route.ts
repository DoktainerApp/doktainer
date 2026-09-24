import { NextResponse } from "next/server";

export const revalidate = 3600;

const GITHUB_LATEST_RELEASE =
  "https://api.github.com/repos/DoktainerApp/doktainer/releases/latest";

export async function GET() {
  try {
    const response = await fetch(GITHUB_LATEST_RELEASE, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Doktainer",
      },
      next: { revalidate },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: "Latest release is unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const release = (await response.json()) as { tag_name?: unknown };
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";

    if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
      return NextResponse.json(
        { success: false, error: "Latest release version is invalid" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        version: tag.startsWith("v") ? tag : `v${tag}`,
        url: `https://github.com/DoktainerApp/doktainer/releases/tag/${encodeURIComponent(tag)}`,
      },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "Latest release is unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
