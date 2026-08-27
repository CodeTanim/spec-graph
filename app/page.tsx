import { redirect } from "next/navigation";
import { getCurrentIdentity } from "../lib/auth/current-user";
import { SignOutButton } from "./sign-out-button";
import { SpecGraphApp } from "./specgraph-app";

export default async function Home() {
  const identity = await getCurrentIdentity();
  if (!identity) redirect("/sign-in");

  return <SpecGraphApp accountAction={<SignOutButton />} />;
}
