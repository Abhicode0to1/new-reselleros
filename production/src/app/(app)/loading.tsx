import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown inside the sidebar while the next page's code and data load (R-052). Before
 * this, a click on a menu link left the old page frozen with no sign anything happened.
 * Shape: title, a strip of numbers, then rows — what most pages here look like.
 */
export default function AppLoading() {
  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-3 w-24 mb-2" />
      <Skeleton className="h-9 w-64 mb-6" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
      </div>
      <div className="space-y-2">
        {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    </div>
  );
}
