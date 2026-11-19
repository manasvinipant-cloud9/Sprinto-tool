"use client";
import { Shell } from "@/components/Shell";
import { WorkspaceProvider } from "@/components/workspace";

export default function Home() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}
