import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { toErrorResponse } from "@/lib/api-error";
import {
  exportMarginCsv,
  exportOrdersCsv,
  exportPreordersCsv,
} from "@/lib/admin";

/**
 * CSV downloads. The report is chosen by query string, and each one re-checks
 * the caller's role inside lib/ — the margin report is super-admin only.
 */
export async function GET(request: Request) {
  const report = new URL(request.url).searchParams.get("report") ?? "orders";

  try {
    const user = await getCurrentUser();

    const { csv, filename } = await (async () => {
      switch (report) {
        case "preorders":
          return {
            csv: await exportPreordersCsv(user),
            filename: "preorders.csv",
          };
        case "margin":
          return { csv: await exportMarginCsv(user), filename: "margin.csv" };
        case "orders":
          return { csv: await exportOrdersCsv(user), filename: "orders.csv" };
        default:
          throw Object.assign(new Error("Unknown report."), { status: 400 });
      }
    })();

    return new NextResponse(csv, {
      headers: {
        // UTF-8 with a BOM, so spreadsheet software reads accented
        // characters and Bengali text correctly.
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
