import { HeaderThemeProvider } from "@/components/header-theme";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/*
 * Every storefront page is rendered per request: the header above reads the
 * catalogue (its categories and their live counts) and the signed-in visitor,
 * neither of which can be settled when the application is built.
 */
export const dynamic = "force-dynamic";

export default function StorefrontLayout({
  children,
}: LayoutProps<"/">) {
  return (
    /*
     * The provider carries two facts from the hero back up to the header, which
     * is rendered here rather than by the page: how light the current slide is,
     * and whether the photograph has scrolled away. See header-theme.tsx.
     */
    <HeaderThemeProvider>
      <div className="flex min-h-full flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </div>
    </HeaderThemeProvider>
  );
}
