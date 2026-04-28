import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// The Coaches tab was merged into the Roster page (/admin/ceos). This route
// kept for backwards-compat with bookmarks.
export default function AdminIndexPage() {
  redirect('/admin/ceos');
}
