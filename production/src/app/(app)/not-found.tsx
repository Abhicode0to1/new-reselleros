import { NotFoundView } from "@/components/shared/not-found-view";

/** notFound() from a page inside the app — keeps the sidebar so there is a way out. */
export default function AppNotFound() {
  return <NotFoundView inApp />;
}
