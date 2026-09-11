import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { products } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import { exportCsv, exportHtml, exportJson, getSeoPulseRun } from "@/lib/seo-pulse";
import { seoPulseExportFormat } from "@/lib/validation/seo-pulse";

const TYPES = {
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
} as const;

/** Download a run as JSON, CSV or a readable HTML report. Staff only. */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/seo-pulse/runs/[runId]/export">,
) {
  const { runId } = await context.params;
  const format = seoPulseExportFormat.safeParse(
    new URL(request.url).searchParams.get("format") ?? "json",
  );
  if (!z.string().uuid().safeParse(runId).success || !format.success) {
    return NextResponse.json({ error: "That research was not found." }, { status: 404 });
  }

  try {
    // getSeoPulseRun checks catalog.manage before reading anything.
    const run = await getSeoPulseRun(await getCurrentUser(), runId);
    if (!run) {
      return NextResponse.json({ error: "That research was not found." }, { status: 404 });
    }
    const [product] = await db
      .select({ title: products.title, slug: products.slug })
      .from(products)
      .where(eq(products.id, run.productId));
    const title = product?.title ?? run.inputSnapshot.title;
    const name = `seo-pulse-${product?.slug ?? run.productId}-v${run.version}`;

    const body =
      format.data === "json"
        ? exportJson(run, title)
        : format.data === "csv"
          ? // A byte-order mark so Excel reads the file as UTF-8.
            `﻿${exportCsv(run, title)}`
          : exportHtml(run, title);

    return new NextResponse(body, {
      headers: {
        "content-type": TYPES[format.data],
        "content-disposition": `${format.data === "html" ? "inline" : "attachment"}; filename="${name}.${format.data}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
