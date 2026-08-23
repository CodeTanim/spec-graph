import { redirect } from "next/navigation";
import { getCurrentIdentity } from "../lib/auth/current-user";
import { SpecGraphApp } from "./specgraph-app";

export default async function Home() {
  if (!(await getCurrentIdentity())) redirect("/sign-in");
  return <SpecGraphApp />;
}
