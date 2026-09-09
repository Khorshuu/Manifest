import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_UPLOAD_DIR } from "@/lib/providers/media/local";
import { contentTypeForExtension } from "@/lib/providers/media/types";

/**
 * Serves a locally stored upload.
 *
 * Uploaded files cannot live in `public/`: Next resolves that directory when
 * the application is built, so anything written there afterwards is not served
 * by `next start`. Reading from disk per request works in both, and keeps the
 * local provider shaped like the object-storage one that will replace it.
 *
 * The key is validated against the exact shape this system generates rather
 * than merely being checked for `..`. A whitelist cannot be talked into
 * matching a path; a blacklist eventually can.
 */
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z0-9]{3,4})$/;

export async function GET(
  _request: Request,
  { params }: RouteContext<"/uploads/[key]">,
) {
  const { key } = await params;

  const match = KEY.exec(key);
  if (!match) return new Response("Not found", { status: 404 });

  const contentType = contentTypeForExtension(match[1]);
  if (!contentType) return new Response("Not found", { status: 404 });

  let data: Buffer;
  try {
    data = await readFile(join(LOCAL_UPLOAD_DIR, key));
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      // The name contains a UUID, so a given URL always holds the same bytes.
      "Cache-Control": "public, max-age=31536000, immutable",
      // Belt and braces: the type is decided here, never sniffed downstream.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
