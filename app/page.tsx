import { redirect } from "next/navigation";
import { getCurrentIdentity } from "../lib/auth/current-user";
import { SpecGraphApp } from "./specgraph-app";

export default async function Home() {
  const identity = await getCurrentIdentity();
  if (!identity) redirect("/sign-in");

  return <SpecGraphApp />;
}
