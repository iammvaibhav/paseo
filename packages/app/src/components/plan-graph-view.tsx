import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { navigateToAgent } from "@/utils/navigate-to-agent";

type DaemonClientLike = Pick<DaemonClient, "respondToPermissionAndWait">;

export type {
  OrchestratorPlanTaskStatus,
  OrchestratorPlanTaskView,
  OrchestratorPlanView,
} from "./plan-graph-view-core";
export {
  isOrchestratorPlanTaskStatus,
  layoutPlanLayers,
  parseOrchestratorPlan,
  planTaskStatusToJsonPatchBriefs,
} from "./plan-graph-view-core";
import { layoutPlanLayers, planTaskStatusToJsonPatchBriefs } from "./plan-graph-view-core";
import type {
  OrchestratorPlanTaskStatus,
  OrchestratorPlanTaskView,
  OrchestratorPlanView,
} from "./plan-graph-view-core";

function planTaskStatusBadgeVariant(status: OrchestratorPlanTaskStatus): StatusBadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "running":
    case "blocked":
      return "warning";
    default:
      return "muted";
  }
}

/**
 * Layered plan graph. Nodes show title, status, files count and the linked
 * child agent. Child chips and node presses open the child agent. In pending
 * mode the card also allows editing briefs and approving/rejecting the plan.
 */
export function PlanGraphView({
  plan,
  mode,
  agentId,
  serverId,
  client,
  requestId,
  onRespond,
  isResponding = false,
  testID,
}: {
  plan: OrchestratorPlanView;
  mode: "pending" | "live";
  agentId: string;
  serverId: string;
  client: Pick<DaemonClientLike, "respondToPermissionAndWait"> | null;
  requestId?: string;
  onRespond?: (response: AgentPermissionResponse) => void;
  isResponding?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { layers } = useMemo(() => layoutPlanLayers(plan.tasks), [plan.tasks]);
  const [editingBriefs, setEditingBriefs] = useState(false);
  const [briefDrafts, setBriefDrafts] = useState<Record<string, string>>({});
  const draftRef = useRef<Record<string, string>>({});
  draftRef.current = briefDrafts;

  useEffect(() => {
    setEditingBriefs(false);
    setBriefDrafts({});
  }, [plan.planId, plan.version]);

  const openChildAgent = useCallback(
    (childAgentId: string) => {
      navigateToAgent({ serverId, agentId: childAgentId });
    },
    [serverId],
  );

  const handleEditBriefs = useCallback(() => {
    const drafts: Record<string, string> = {};
    for (const task of plan.tasks) drafts[task.id] = task.brief;
    setBriefDrafts(drafts);
    setEditingBriefs(true);
  }, [plan.tasks]);

  const handleCancelEdit = useCallback(() => {
    setEditingBriefs(false);
    setBriefDrafts({});
  }, []);

  const approveDisabled = isResponding || !client || !requestId;
  const handleApprove = useCallback(() => {
    if (!client || !requestId) return;
    const changed = planTaskStatusToJsonPatchBriefs({
      planTasks: plan.tasks,
      briefDrafts: editingBriefs
        ? Object.fromEntries(
            plan.tasks.map((task) => [task.id, draftRef.current[task.id] ?? task.brief]),
          )
        : {},
    });
    const response: AgentPermissionResponse =
      changed.length > 0
        ? {
            behavior: "allow" as const,
            selectedActionId: "accept",
            updatedInput: { tasks: changed },
          }
        : { behavior: "allow" as const, selectedActionId: "accept" };
    if (onRespond) {
      onRespond(response);
      return;
    }
    void client
      .respondToPermissionAndWait(agentId, requestId, response, 15000)
      .catch((error: unknown) => {
        console.error("[PlanGraphView] Failed to approve plan:", error);
      });
  }, [agentId, client, editingBriefs, onRespond, plan.tasks, requestId]);

  const handleReject = useCallback(() => {
    if (!client || !requestId) return;
    const response = {
      behavior: "deny" as const,
      selectedActionId: "reject",
      message: "Rejected by user",
    };
    if (onRespond) {
      onRespond(response);
      return;
    }
    void client
      .respondToPermissionAndWait(agentId, requestId, response, 15000)
      .catch((error: unknown) => {
        console.error("[PlanGraphView] Failed to reject plan:", error);
      });
  }, [agentId, client, onRespond, requestId]);

  const handleBriefChange = useCallback((taskId: string, text: string) => {
    setBriefDrafts((previous) => ({ ...previous, [taskId]: text }));
  }, []);

  return (
    <View style={styles.card} testID={testID ?? "orchestrator-plan-graph"}>
      {plan.title ? (
        <Text style={styles.title} testID="orchestrator-plan-title">
          {plan.title}
        </Text>
      ) : null}
      <View style={styles.layers}>
        {layers.map((layer, layerIndex) => (
          <PlanGraphLayer
            key={layer.map((task) => task.id).join("+")}
            layer={layer}
            layerIndex={layerIndex}
            editingBriefs={editingBriefs}
            briefDrafts={briefDrafts}
            mode={mode}
            openChildAgent={openChildAgent}
            onBriefChange={handleBriefChange}
          />
        ))}
      </View>
      {mode === "pending" ? (
        <View style={styles.footer}>
          {editingBriefs ? (
            <Button
              variant="secondary"
              size="sm"
              onPress={handleCancelEdit}
              disabled={isResponding}
              testID="orchestrator-plan-cancel-edit"
            >
              {t("agentStream.permission.cancelEdit")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onPress={handleEditBriefs}
              disabled={isResponding}
              testID="orchestrator-plan-edit-briefs"
            >
              {t("agentStream.permission.editBriefs")}
            </Button>
          )}
          <View style={styles.footerSpacer} />
          <Button
            variant="outline"
            size="sm"
            onPress={handleReject}
            disabled={approveDisabled}
            testID="orchestrator-plan-reject"
          >
            {t("agentStream.permission.reject")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleApprove}
            disabled={approveDisabled}
            testID="orchestrator-plan-approve"
          >
            {t("agentStream.permission.approve")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
function PlanGraphLayer({
  layer,
  layerIndex,
  mode,
  editingBriefs,
  briefDrafts,
  openChildAgent,
  onBriefChange,
}: {
  layer: OrchestratorPlanTaskView[];
  layerIndex: number;
  mode: "pending" | "live";
  editingBriefs: boolean;
  briefDrafts: Record<string, string>;
  openChildAgent: (childAgentId: string) => void;
  onBriefChange: (taskId: string, text: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.layer} testID={`orchestrator-plan-layer-${layerIndex}`}>
      {layerIndex > 0 ? <View style={styles.layerDivider} /> : null}
      {layer.map((task) => (
        <PlanGraphNode
          key={task.id}
          task={task}
          filesLabel={t("agentStream.permission.filesCount", {
            count: task.files.length,
          })}
          dependsLabel={t("agentStream.permission.dependsOn")}
          childAgentLabel={t("agentStream.permission.childAgent")}
          onOpenChild={openChildAgent}
          editingBriefs={mode === "pending" && editingBriefs}
          briefDraft={briefDrafts[task.id] ?? task.brief}
          onBriefChange={onBriefChange}
        />
      ))}
    </View>
  );
}

function PlanGraphNode({
  task,
  filesLabel,
  dependsLabel,
  childAgentLabel,
  onOpenChild,
  editingBriefs,
  briefDraft,
  onBriefChange,
}: {
  task: OrchestratorPlanTaskView;
  filesLabel: string;
  dependsLabel: string;
  childAgentLabel: string;
  onOpenChild: (childAgentId: string) => void;
  editingBriefs: boolean;
  briefDraft: string;
  onBriefChange: (taskId: string, text: string) => void;
}) {
  const handleOpenChild = useCallback(() => {
    if (task.childAgentId) onOpenChild(task.childAgentId);
  }, [onOpenChild, task.childAgentId]);
  const handleBriefChange = useCallback(
    (text: string) => onBriefChange(task.id, text),
    [onBriefChange, task.id],
  );
  const body = (
    <View style={styles.node}>
      <View style={styles.nodeHeader}>
        <Text style={styles.nodeTitle} numberOfLines={2} testID={`plan-task-${task.id}-title`}>
          {task.title}
        </Text>
        <StatusBadge
          label={task.status}
          variant={planTaskStatusBadgeVariant(task.status)}
          testID={`plan-task-${task.id}-status`}
        />
      </View>
      <Text style={styles.nodeMeta} testID={`plan-task-${task.id}-files`}>
        {filesLabel}
      </Text>
      {task.dependsOn.length > 0 ? (
        <Text style={styles.nodeMeta} testID={`plan-task-${task.id}-depends`}>
          {dependsLabel}: {task.dependsOn.join(", ")}
        </Text>
      ) : null}
      {editingBriefs ? (
        <FormTextInput
          size="sm"
          initialValue={briefDraft}
          onChangeText={handleBriefChange}
          testID={`plan-task-${task.id}-brief-input`}
          accessibilityLabel={task.title}
          multiline
        />
      ) : (
        <Text style={styles.nodeBrief} numberOfLines={4} testID={`plan-task-${task.id}-brief`}>
          {briefDraft}
        </Text>
      )}
      {task.childAgentId ? (
        <Pressable
          onPress={handleOpenChild}
          accessibilityRole="button"
          accessibilityLabel={`${childAgentLabel}: ${task.childAgentId}`}
          testID={`plan-task-${task.id}-child`}
          style={styles.childChip}
        >
          <Text style={styles.childChipText} numberOfLines={1}>
            {childAgentLabel}: {task.childAgentId}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  if (!task.childAgentId) return body;
  return (
    <Pressable
      onPress={handleOpenChild}
      accessibilityRole="button"
      accessibilityLabel={`${childAgentLabel}: ${task.childAgentId}`}
      testID={`plan-task-${task.id}-open-child`}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  layers: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  layer: {
    flexDirection: "column",
    gap: theme.spacing[2],
  },
  layerDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  node: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[2],
    gap: theme.spacing[1],
  },
  nodeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  nodeTitle: {
    flex: 1,
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  nodeMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  nodeBrief: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  childChip: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  childChipText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerSpacer: {
    flex: 1,
  },
}));
