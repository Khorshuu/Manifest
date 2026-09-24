import type { SessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/authorize";
import { getVocabularyView } from "@/lib/pkb/intelligence";
import { LabelMapper } from "@/app/admin/knowledge/label-mapper";
import { TrustManager } from "@/app/admin/knowledge/trust-manager";
import { Metric, MetricGrid, Section, TabHeading } from "../ui";

/**
 * The Sources &amp; Policies tab: the rules the rest of Intelligence obeys.
 *
 * Everything else in this workspace reports what happened. This is the only
 * tab that changes what will happen next — which domains are allowed to speak
 * for a brand, which brands stand behind which, what counts as evidence
 * enough to call a value verified, and what a supplied label means. A decision
 * here is applied to every future research run, which is why the copy explains
 * each control rather than assuming the reader knows the vocabulary.
 *
 * No registry, policy system or vocabulary is created here. These are the
 * existing `lib/pkb` trust surfaces — the same components the Knowledge screen
 * has always rendered — gathered behind one heading. Reading is a catalogue
 * permission; every decision asks for `knowledge.manage`, and each API route
 * checks it again.
 */
export async function SourcesPanel({ user }: { user: SessionUser }) {
  const vocabulary = await getVocabularyView(user);
  const mayDecide = can(user, "knowledge.manage");

  const suggestedSources = vocabulary.registry.filter((entry) => entry.status === "suggested").length;
  const approvedSources = vocabulary.registry.filter((entry) => entry.status === "approved").length;
  const blockedSources = vocabulary.registry.filter((entry) => entry.role === "blocked").length;
  const suggestedRelations = vocabulary.brandRelations.filter((row) => row.status === "suggested").length;
  const activePolicies = vocabulary.policies.filter((policy) => policy.status === "active").length;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <TabHeading title="Sources &amp; Policies">
        The rules research runs under. Which domains speak for a brand, which brands stand behind which, what counts
        as evidence enough to call a value verified, and what a supplied label means. A change here applies to every
        product researched afterwards.
      </TabHeading>

      {!mayDecide ? (
        <p className="admin-card p-3.5 text-[0.8125rem] text-ink/70">
          You can read these rules. Approving a source, a brand relation, a policy or a label mapping needs the
          product-knowledge permission, which your role does not hold.
        </p>
      ) : null}

      <MetricGrid>
        <Metric
          label="Trusted sources"
          value={approvedSources}
          note="domains and feeds approved"
        />
        <Metric
          label="Sources suggested"
          value={suggestedSources}
          note="waiting for a decision"
          tone={suggestedSources > 0 ? "attention" : "plain"}
        />
        <Metric label="Blocked sources" value={blockedSources} note="never used as evidence" />
        <Metric
          label="Brand relations suggested"
          value={suggestedRelations}
          note="waiting for a decision"
          tone={suggestedRelations > 0 ? "attention" : "plain"}
        />
        <Metric label="Verification policies" value={activePolicies} note="in force" />
        <Metric
          label="Labels to place"
          value={vocabulary.unmappedLabels.length}
          note="no attribute answers to them"
          tone={vocabulary.unmappedLabels.length > 0 ? "attention" : "plain"}
        />
        <Metric label="Attributes" value={vocabulary.definitions.length} note="the shared vocabulary" />
        <Metric label="Product families" value={vocabulary.families.length} note="what an attribute belongs to" />
      </MetricGrid>

      <Section
        id="labels"
        title="Label mapping"
        description="A written label is only attached to an attribute by exact match, so anything phrased differently waits here. Mapping it once is remembered and applied to every later row with the same label."
      >
        <LabelMapper
          groups={vocabulary.unmappedLabels}
          definitions={vocabulary.definitions}
          mappings={vocabulary.labelMappings}
          mayDecide={mayDecide}
          heading={false}
        />
      </Section>

      <Section
        id="registry"
        title="Sources, brands and verification"
        description="A brand existing in the catalogue is not trust. Every entry starts as a suggestion and carries no authority until somebody approves it, and a blocked domain overrides any other entry for the same host."
      >
        <TrustManager
          registry={vocabulary.registry}
          policies={vocabulary.policies}
          relations={vocabulary.brandRelations}
          mayDecide={mayDecide}
          heading={false}
        />
      </Section>
    </div>
  );
}
