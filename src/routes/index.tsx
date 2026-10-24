import { createFileRoute } from "@tanstack/react-router";
import { MineScreen } from "@/components/mine-screen";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <MineScreen />;
}
