"use client";

import { useEffect, useState } from "react";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";

type Project = {
  id: string;
  name: string;
  code: string;
  status: string;
  created_at: string;
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-[#1A2E1A] text-[#4ADE80]",
  inactive: "bg-[#2A2A1A] text-[#FACC15]",
  archived: "bg-[#1A1F27] text-[#8B94A3]",
};

export default function ProjectsPage() {
  const supabase = createClientComponentClient();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProjects() {
      setLoading(true);
      setError(null);
      try {
        // Get the current user's organization_id from user_profiles
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          setError("Not authenticated.");
          setLoading(false);
          return;
        }

        const { data: profile, error: profileError } = await supabase
          .from("user_profiles")
          .select("organization_id")
          .eq("id", user.id)
          .single();

        if (profileError || !profile) {
          setError("Could not load user profile.");
          setLoading(false);
          return;
        }

        const { data: projectData, error: projectError } = await supabase
          .from("projects")
          .select("id, name, code, status, created_at")
          .eq("organization_id", profile.organization_id)
          .order("created_at", { ascending: false });

        if (projectError) {
          setError("Failed to load projects.");
        } else {
          setProjects(projectData ?? []);
        }
      } catch {
        setError("An unexpected error occurred.");
      } finally {
        setLoading(false);
      }
    }

    fetchProjects();
  }, [supabase]);

  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h2 className="mb-1 text-sm font-semibold text-[#F1F3F5]">Projects</h2>
          <p className="text-xs text-[#8B94A3]">
            Track and manage active projects across your organization. Monitor
            progress, milestones, and team assignments from a single view.
          </p>
        </div>
        <div className="shrink-0">
          <button
            type="button"
            className="rounded-md bg-[#7C5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#6A4DE0]"
          >
            New Project
          </button>
        </div>
      </section>

      {loading && (
        <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
          <div className="text-[11px] text-[#8B94A3]">Loading projects…</div>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-[#2A1A1A] bg-[#0F1115] p-4">
          <div className="text-[11px] font-medium text-red-400">{error}</div>
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div className="rounded-lg border border-[#1A1F27] bg-[#0F1115] p-4">
          <div className="text-[11px] font-medium text-[#F1F3F5]">No projects yet</div>
          <div className="mt-1 text-[11px] text-[#8B94A3]">
            Projects will appear here once they are created.
          </div>
        </div>
      )}

      {!loading && !error && projects.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-[#1A1F27] bg-[#0F1115]">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-[#1A1F27]">
                <th className="px-4 py-3 text-left font-medium text-[#8B94A3]">Code</th>
                <th className="px-4 py-3 text-left font-medium text-[#8B94A3]">Name</th>
                <th className="px-4 py-3 text-left font-medium text-[#8B94A3]">Status</th>
                <th className="px-4 py-3 text-left font-medium text-[#8B94A3]">Created</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr
                  key={project.id}
                  className="border-b border-[#1A1F27] last:border-0 hover:bg-[#13171E]"
                >
                  <td className="px-4 py-3 font-mono text-[#8B94A3]">{project.code}</td>
                  <td className="px-4 py-3 font-medium text-[#F1F3F5]">{project.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium capitalize ${
                        STATUS_STYLES[project.status] ?? STATUS_STYLES["archived"]
                      }`}
                    >
                      {project.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#8B94A3]">
                    {new Date(project.created_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
