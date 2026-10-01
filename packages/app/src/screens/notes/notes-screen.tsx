import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { router, useLocalSearchParams } from "expo-router";
import { CloudOff, NotebookPen } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { NoteDetail, NoteSummary } from "@getpaseo/protocol/notes/types";
import { buildAgentDeepLinkRoute } from "@getpaseo/protocol/agent-deep-link";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHostProjects } from "@/projects/host-projects";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveFocusedChatTarget } from "@/composer/focused-chat-target";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import {
  useNoteDetail,
  useNoteList,
  useNoteMutations,
  type NoteListFilters,
} from "@/notes/queries";
import { useNotesHost } from "@/notes/use-notes-host";
import { deriveNoteTitle } from "@/notes/mentions";

const ThemedNotebookPen = withUnistyles(NotebookPen);
const ThemedCloudOff = withUnistyles(CloudOff);
const EMPTY_ICON = <ThemedNotebookPen size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;
const OFFLINE_ICON = <ThemedCloudOff size={ICON_SIZE.lg} uniProps={mutedIconColorMapping} />;
const SEARCH_DEBOUNCE_MS = 200;
const NOTE_ID_PATTERN = /^nte_[0-9a-f]{16}$/;

interface NotesRouteRef {
  noteId?: string;
  slug?: string;
}

function parseNoteParam(value: string | string[] | undefined): NotesRouteRef | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return null;
  }
  return NOTE_ID_PATTERN.test(raw) ? { noteId: raw } : { slug: raw };
}

function refMatches(note: NoteSummary, ref: NotesRouteRef): boolean {
  if (ref.noteId && note.id === ref.noteId) {
    return true;
  }
  if (ref.slug && note.slug === ref.slug) {
    return true;
  }
  return false;
}

function formatNoteTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function NotesScreen(): ReactElement {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ note?: string | string[] }>();
  const selectedRef = useMemo(() => parseNoteParam(params.note), [params.note]);
  const compact = useIsCompactFormFactor();
  const { status, hostLabel, isConnecting } = useNotesHost();
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const filters = useMemo<NoteListFilters>(
    () => ({
      ...(debouncedSearch.trim() ? { query: debouncedSearch.trim() } : {}),
      ...(tag ? { tag } : {}),
      ...(projectKey ? { projectKey } : {}),
    }),
    [debouncedSearch, tag, projectKey],
  );
  const { notes, isLoading, error } = useNoteList(filters);
  const selectNote = useCallback((note: NoteSummary) => {
    setCreating(false);
    router.setParams({ note: note.slug });
  }, []);
  const clearSelection = useCallback(() => {
    setCreating(false);
    router.setParams({ note: undefined });
  }, []);
  const startCreating = useCallback(() => {
    router.setParams({ note: undefined });
    setCreating(true);
  }, []);

  const stopCreating = useCallback(() => {
    setCreating(false);
  }, []);

  const selected = useMemo(
    () =>
      creating || !selectedRef
        ? null
        : (notes.find((note) => refMatches(note, selectedRef)) ?? null),
    [creating, notes, selectedRef],
  );
  const detailRef = useMemo<NotesRouteRef | null>(() => {
    if (selected) {
      return { noteId: selected.id };
    }
    if (selectedRef && !creating) {
      return selectedRef;
    }
    return null;
  }, [creating, selected, selectedRef]);
  const selectedId = selected?.id ?? null;
  const newNoteLabel = t("notes.list.newNote");
  const headerRightContent = useMemo(
    () => (
      <Button variant="secondary" size="sm" onPress={startCreating} testID="notes-new">
        {newNoteLabel}
      </Button>
    ),
    [newNoteLabel, startCreating],
  );
  const list = (
    <NotesList
      notes={notes}
      isLoading={isLoading}
      search={search}
      onSearch={setSearch}
      tag={tag}
      onTag={setTag}
      projectKey={projectKey}
      onProjectKey={setProjectKey}
      selectedId={selectedId}
      onSelect={selectNote}
      filters={filters}
      headerRightContent={headerRightContent}
    />
  );
  if (status !== "ready") {
    return <NotesHostState status={status} hostLabel={hostLabel} isConnecting={isConnecting} />;
  }
  if (error) {
    return (
      <NotesStateMessage
        testID="notes-load-failed"
        icon={OFFLINE_ICON}
        title={t("notes.list.states.loadFailed", { message: error.message })}
      />
    );
  }
  if (compact) {
    if (creating) {
      return <NoteEditor note={null} onClose={stopCreating} onDeleted={clearSelection} />;
    }
    if (selectedRef) {
      return (
        <NoteDetailRoute
          detailRef={detailRef}
          selected={selected}
          onBack={clearSelection}
          onDeleted={clearSelection}
        />
      );
    }
    return list;
  }
  return (
    <View style={styles.split}>
      <View style={styles.listPane}>{list}</View>
      <View style={styles.detailPane}>
        {creating ? (
          <NoteEditor note={null} onClose={stopCreating} onDeleted={clearSelection} />
        ) : (
          <NoteDetailRoute
            detailRef={detailRef}
            selected={selected}
            onBack={clearSelection}
            onDeleted={clearSelection}
          />
        )}
      </View>
    </View>
  );
}

function NoteDetailRoute({
  detailRef,
  selected,
  onBack,
  onDeleted,
}: {
  detailRef: NotesRouteRef | null;
  selected: NoteSummary | null;
  onBack: () => void;
  onDeleted: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { note, isLoading } = useNoteDetail(detailRef);
  const resolved = useMemo<NoteDetail | null>(() => {
    if (note) {
      return note;
    }
    if (selected) {
      return { ...selected, body: "", images: [] };
    }
    return null;
  }, [note, selected]);
  const editorKey = resolved?.id;
  const editor = useMemo(() => {
    if (!resolved || !editorKey) {
      return null;
    }
    return <NoteEditor key={editorKey} note={resolved} onClose={onBack} onDeleted={onDeleted} />;
  }, [editorKey, onBack, onDeleted, resolved]);
  if (!detailRef) {
    return (
      <NotesStateMessage
        testID="notes-detail-empty"
        icon={EMPTY_ICON}
        title={t("notes.list.states.empty.title")}
        description={t("notes.list.states.empty.description")}
      />
    );
  }
  if (isLoading) {
    return (
      <View style={styles.centered} testID="notes-detail-loading">
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }
  if (!editor) {
    return (
      <NotesStateMessage
        testID="notes-detail-missing"
        icon={EMPTY_ICON}
        title={t("notes.detail.states.notFound")}
      />
    );
  }
  return editor;
}
function NotesRow({
  note,
  bordered,
  selected,
  onSelect,
}: {
  note: NoteSummary;
  bordered: boolean;
  selected: boolean;
  onSelect: (note: NoteSummary) => void;
}): ReactElement {
  const handlePress = useCallback(() => {
    onSelect(note);
  }, [note, onSelect]);
  const tagsSuffix = note.tags.length > 0 ? ` · #${note.tags.join(" #")}` : "";
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      testID={`notes-row-${note.slug}`}
      style={[settingsStyles.row, bordered && settingsStyles.rowBorder]}
    >
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {note.title}
        </Text>
        {note.preview ? (
          <Text style={styles.rowPreview} numberOfLines={2}>
            {note.preview}
          </Text>
        ) : null}
        <Text style={styles.rowMeta} numberOfLines={1}>
          {formatNoteTimestamp(note.updatedAt)}
          {tagsSuffix}
        </Text>
      </View>
      {selected ? <View style={styles.selectedDot} /> : null}
    </Pressable>
  );
}

function NotesList({
  notes,
  isLoading,
  search,
  onSearch,
  tag,
  onTag,
  projectKey,
  onProjectKey,
  selectedId,
  onSelect,
  filters,
  headerRightContent,
}: {
  notes: readonly NoteSummary[];
  isLoading: boolean;
  search: string;
  onSearch: (value: string) => void;
  tag: string | null;
  onTag: (value: string | null) => void;
  projectKey: string | null;
  onProjectKey: (value: string | null) => void;
  selectedId: string | null;
  onSelect: (note: NoteSummary) => void;
  filters: NoteListFilters;
  headerRightContent: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const { serverId } = useNotesHost();
  const hostProjects = useHostProjects(serverId ? [serverId] : []);
  const tagOptions = useMemo(() => {
    const tags = new Set<string>();
    for (const note of notes) {
      for (const noteTag of note.tags) {
        tags.add(noteTag);
      }
    }
    return [...tags].sort((left, right) => left.localeCompare(right));
  }, [notes]);
  const projectOptions = useMemo(
    () =>
      hostProjects.flatMap((project) =>
        project.projectKey ? [{ key: project.projectKey, name: project.projectName }] : [],
      ),
    [hostProjects],
  );
  const projectKeys = useMemo(() => projectOptions.map((option) => option.key), [projectOptions]);
  const projectLabels = useMemo(
    () => new Map(projectOptions.map((option) => [option.key, option.name] as const)),
    [projectOptions],
  );
  const activeProjectName = projectOptions.find((option) => option.key === projectKey)?.name;
  const isFiltering = Boolean(filters.query || filters.tag || filters.projectKey);
  return (
    <View style={styles.list} testID="notes-list">
      <MenuHeader title={t("notes.list.title")} rightContent={headerRightContent} />
      <SearchField
        value={search}
        onChangeText={onSearch}
        placeholder={t("notes.list.searchPlaceholder")}
        clearAccessibilityLabel={t("notes.list.searchPlaceholder")}
        testID="notes-search"
      />
      <View style={styles.filterRow}>
        <NoteFilterPicker
          label={tag ? `#${tag}` : t("notes.list.filters.tag")}
          options={tagOptions}
          allLabel={t("notes.list.filters.allTags")}
          onPick={onTag}
          testID="notes-tag-filter"
        />
        {projectOptions.length > 0 ? (
          <NoteFilterPicker
            label={activeProjectName ?? t("notes.list.filters.project")}
            options={projectKeys}
            optionLabels={projectLabels}
            allLabel={t("notes.list.filters.allProjects")}
            onPick={onProjectKey}
            testID="notes-project-filter"
          />
        ) : null}
      </View>
      <NotesListBody
        notes={notes}
        isLoading={isLoading}
        isFiltering={isFiltering}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </View>
  );
}

function NotesListBody({
  notes,
  isLoading,
  isFiltering,
  selectedId,
  onSelect,
}: {
  notes: readonly NoteSummary[];
  isLoading: boolean;
  isFiltering: boolean;
  selectedId: string | null;
  onSelect: (note: NoteSummary) => void;
}): ReactElement {
  const { t } = useTranslation();
  if (isLoading && notes.length === 0) {
    return (
      <View style={styles.centered} testID="notes-list-loading">
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }
  if (notes.length === 0) {
    return (
      <NotesStateMessage
        testID={isFiltering ? "notes-list-no-matches" : "notes-list-empty"}
        icon={EMPTY_ICON}
        title={
          isFiltering ? t("notes.list.states.noMatches.title") : t("notes.list.states.empty.title")
        }
        description={
          isFiltering
            ? t("notes.list.states.noMatches.description")
            : t("notes.list.states.empty.description")
        }
      />
    );
  }
  return (
    <View style={settingsStyles.card}>
      {notes.map((note, index) => (
        <NotesRow
          key={note.id}
          note={note}
          bordered={index > 0}
          selected={selectedId === note.id}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

function NoteFilterPicker({
  label,
  options,
  optionLabels,
  allLabel,
  onPick,
  testID,
}: {
  label: string;
  options: readonly string[];
  optionLabels?: ReadonlyMap<string, string>;
  allLabel: string;
  onPick: (value: string | null) => void;
  testID: string;
}): ReactElement {
  const clearLabel = `${testID}-all`;
  const handleClear = useCallback(() => {
    onPick(null);
  }, [onPick]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger testID={testID}>
        <View style={styles.filterTrigger}>
          <Text style={styles.filterLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={handleClear} testID={clearLabel}>
          {allLabel}
        </DropdownMenuItem>
        {options.map((option) => (
          <NoteFilterOption
            key={option}
            option={option}
            optionLabels={optionLabels}
            onPick={onPick}
            testID={testID}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NoteFilterOption({
  option,
  optionLabels,
  onPick,
  testID,
}: {
  option: string;
  optionLabels: ReadonlyMap<string, string> | undefined;
  onPick: (value: string | null) => void;
  testID: string;
}): ReactElement {
  const handleSelect = useCallback(() => {
    onPick(option);
  }, [onPick, option]);
  const label = optionLabels?.get(option) ?? `#${option}`;
  const itemTestID = `${testID}-${option}`;
  return (
    <DropdownMenuItem onSelect={handleSelect} testID={itemTestID}>
      {label}
    </DropdownMenuItem>
  );
}

type EditorTab = "write" | "preview";

function NoteEditor({
  note,
  onClose,
  onDeleted,
}: {
  note: NoteDetail | null;
  onClose: () => void;
  onDeleted: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const mutations = useNoteMutations();
  const toast = useToast();
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [tagsText, setTagsText] = useState((note?.tags ?? []).join(", "));
  const [tab, setTab] = useState<EditorTab>("write");
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  useEffect(() => {
    setTitle(note?.title ?? "");
    setBody(note?.body ?? "");
    setTagsText((note?.tags ?? []).join(", "));
    setTab("write");
    setErrorMessage(null);
  }, [note]);
  const tabs = useMemo<SegmentedControlOption<EditorTab>[]>(
    () => [
      { value: "write", label: t("notes.detail.write") },
      { value: "preview", label: t("notes.detail.preview") },
    ],
    [t],
  );
  const tags = useMemo(
    () =>
      tagsText
        .split(/[,]+/)
        .flatMap((part) => part.split(/\s+/))
        .map((part) => part.replace(/^#+/, "").trim().toLowerCase())
        .filter((part) => part.length > 0),
    [tagsText],
  );
  const handleSave = useCallback(async () => {
    setPending(true);
    setErrorMessage(null);
    try {
      const resolvedTitle = title.trim() || deriveNoteTitle(body);
      const saved = await mutations.upsertNote({
        ...(note ? { noteId: note.id } : {}),
        title: resolvedTitle,
        body,
        tags,
      });
      router.setParams({ note: saved.slug });
      onClose();
    } catch (error) {
      setErrorMessage(
        t("notes.detail.errors.save", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setPending(false);
    }
  }, [body, mutations, note, onClose, tags, title, t]);
  const handleDelete = useCallback(async () => {
    if (!note) {
      onClose();
      return;
    }
    const confirmed = await confirmDialog({
      title: t("notes.detail.deleteTitle"),
      message: t("notes.detail.deleteMessage", { title: note.title }),
      confirmLabel: t("notes.detail.deleteConfirm"),
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    setPending(true);
    try {
      await mutations.deleteNote({ noteId: note.id });
      toast.show(t("notes.detail.delete"));
      onDeleted();
    } catch (error) {
      setErrorMessage(
        t("notes.detail.errors.delete", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setPending(false);
    }
  }, [mutations, note, onDeleted, onClose, t, toast]);
  return (
    <View style={styles.editor} testID="notes-editor">
      <FormTextInput
        initialValue={title}
        onChangeText={setTitle}
        placeholder={t("notes.detail.titlePlaceholder")}
        accessibilityLabel={t("notes.detail.titleLabel")}
        testID="notes-editor-title"
      />
      <SegmentedControl options={tabs} value={tab} onValueChange={setTab} size="xs" />
      {tab === "write" ? (
        <FormTextInput
          initialValue={body}
          onChangeText={setBody}
          multiline
          placeholder={t("notes.detail.bodyPlaceholder")}
          accessibilityLabel={t("notes.detail.bodyLabel")}
          style={styles.bodyInput}
          testID="notes-editor-body"
        />
      ) : (
        <View style={styles.preview} testID="notes-editor-preview">
          {body.trim() === "" ? (
            <Text style={styles.rowPreview}>{t("notes.detail.emptyPreview")}</Text>
          ) : (
            <MarkdownRenderer text={body} />
          )}
        </View>
      )}
      <FormTextInput
        initialValue={tagsText}
        onChangeText={setTagsText}
        placeholder={t("notes.detail.tagsPlaceholder")}
        accessibilityLabel={t("notes.detail.tagsLabel")}
        testID="notes-editor-tags"
      />
      {errorMessage ? (
        <Text style={styles.errorText} testID="notes-editor-error">
          {errorMessage}
        </Text>
      ) : null}
      <NoteSourceRow note={note} />
      <View style={styles.editorFooter}>
        {note ? (
          <Button
            variant="outline"
            size="sm"
            onPress={handleDelete}
            disabled={pending}
            testID="notes-editor-delete"
          >
            {pending ? t("notes.detail.deleting") : t("notes.detail.delete")}
          </Button>
        ) : null}
        <View style={styles.editorButtons}>
          <Button
            variant="ghost"
            size="sm"
            onPress={onClose}
            disabled={pending}
            testID="notes-editor-cancel"
          >
            {t("notes.detail.cancel")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleSave}
            disabled={pending}
            testID="notes-editor-save"
          >
            {pending ? t("notes.detail.saving") : t("notes.detail.save")}
          </Button>
        </View>
      </View>
    </View>
  );
}

function NoteSourceRow({ note }: { note: NoteDetail | null }): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId } = useNotesHost();
  const { addNoteToChat, canAddToChat } = useAddNoteToChat({ serverId });
  const sourceAgentId = note?.sourceAgentId;
  const handleAddToChat = useCallback(async () => {
    if (!note) {
      return;
    }
    const added = await addNoteToChat(note);
    if (added) {
      toast.show(t("notes.detail.addedToChat"));
    } else {
      toast.error(t("notes.detail.noChat"));
    }
  }, [addNoteToChat, note, t, toast]);
  const openSourceChat = useCallback(() => {
    if (sourceAgentId && serverId) {
      router.push(buildAgentDeepLinkRoute({ serverId, agentId: sourceAgentId }));
    }
  }, [sourceAgentId, serverId]);
  if (!note) {
    return null;
  }
  const sourceLabel = sourceAgentId
    ? t("notes.detail.sourceAgent", { agent: sourceAgentId })
    : null;
  return (
    <View style={styles.sourceRow}>
      {sourceLabel ? <Text style={styles.rowMeta}>{sourceLabel}</Text> : null}
      {note.sourceAgentId && serverId ? (
        <Button variant="ghost" size="xs" testID="notes-from-chat" onPress={openSourceChat}>
          {t("notes.detail.fromChat")}
        </Button>
      ) : null}
      {canAddToChat ? (
        <Button variant="ghost" size="xs" onPress={handleAddToChat} testID="notes-add-to-chat">
          {t("notes.detail.addToChat")}
        </Button>
      ) : null}
    </View>
  );
}

/**
 * Append a note's body to the focused chat draft as the contract's fenced
 * block (same shape as @note injection). Read-only when no chat is visible.
 */
export function useAddNoteToChat(input: { serverId: string | null }): {
  addNoteToChat: (note: Pick<NoteDetail, "title" | "body">) => Promise<boolean>;
  canAddToChat: boolean;
} {
  const serverId = input.serverId ?? "";
  const layouts = useWorkspaceLayoutStore((state) => state.layoutByWorkspace);
  void layouts;
  const layoutValues = useWorkspaceLayoutStore((state) => Object.values(state.layoutByWorkspace));
  const focusedChat = useMemo(() => {
    if (!serverId) {
      return null;
    }
    for (const layout of layoutValues) {
      const target = resolveFocusedChatTarget({ serverId, layout });
      if (target) {
        return target;
      }
    }
    return null;
  }, [layoutValues, serverId]);
  const addNoteToChat = useCallback(
    async (note: Pick<NoteDetail, "title" | "body">) => {
      if (!focusedChat) {
        return false;
      }
      const current = useDraftStore.getState().getDraftInput(focusedChat.draftKey);
      const block = `---\nReferenced note "${note.title}":\n\n${note.body}`;
      const next = current?.text ? `${current.text}\n\n${block}` : block;
      useDraftStore.getState().editDraftText({ draftKey: focusedChat.draftKey, text: next });
      return true;
    },
    [focusedChat],
  );
  return { addNoteToChat, canAddToChat: focusedChat !== null };
}

function NotesHostState({
  status,
  hostLabel,
  isConnecting,
}: {
  status: "ready" | "no_notes_host" | "offline";
  hostLabel: string | null;
  isConnecting: boolean;
}): ReactElement {
  const { t } = useTranslation();
  if (isConnecting && status === "offline") {
    return (
      <View style={styles.centered} testID="notes-host-connecting">
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
        <Text style={styles.rowMeta}>{t("notes.list.states.connecting")}</Text>
      </View>
    );
  }
  if (status === "no_notes_host") {
    return (
      <NotesStateMessage
        testID="notes-no-notes-host"
        icon={EMPTY_ICON}
        title={t("notes.list.states.noNotesHost.title")}
        description={t("notes.list.states.noNotesHost.description")}
      />
    );
  }
  return (
    <NotesStateMessage
      testID="notes-host-offline"
      icon={OFFLINE_ICON}
      title={
        hostLabel
          ? t("notes.list.states.offline.title", { host: hostLabel })
          : t("notes.list.states.offlineUnknown.title")
      }
      description={
        hostLabel
          ? t("notes.list.states.offline.description")
          : t("notes.list.states.offlineUnknown.description")
      }
    />
  );
}

function NotesStateMessage({
  icon,
  title,
  description,
  children,
  testID,
}: {
  icon: ReactElement;
  title: string;
  description?: string;
  children?: ReactElement;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.centered} testID={testID}>
      <View style={styles.stack}>
        {icon}
        <View style={styles.textStack}>
          <Text style={styles.title}>{title}</Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
        </View>
        {children ? <View style={styles.actions}>{children}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  split: {
    flex: 1,
    flexDirection: "row",
  },
  listPane: {
    width: 320,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  detailPane: {
    flex: 1,
    padding: theme.spacing[4],
  },
  list: {
    flex: 1,
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  stack: {
    alignItems: "center",
    gap: theme.spacing[4],
    maxWidth: 420,
    width: "100%",
  },
  textStack: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  filterRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  filterTrigger: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  filterLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  rowBody: {
    flex: 1,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  rowPreview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  selectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.accent,
  },
  editor: {
    flex: 1,
    gap: theme.spacing[3],
  },
  bodyInput: {
    minHeight: 200,
  },
  preview: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    minHeight: 200,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  editorFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  editorButtons: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  sourceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
