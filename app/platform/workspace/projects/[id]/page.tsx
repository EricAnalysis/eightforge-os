import { redirect } from 'next/navigation';

export default async function WorkspaceProjectForgePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;

  if (tab === 'validator') {
    redirect(`/platform/projects/${id}#project-validator`);
  }

  redirect(`/platform/projects/${id}`);
}
