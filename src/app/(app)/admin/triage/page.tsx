import { redirect } from 'next/navigation';

// Renamed to /admin/data. Keep this redirect so existing bookmarks /
// in-flight triage links don't 404.
export default function TriageRedirectPage() {
  redirect('/admin/data?view=triage');
}
