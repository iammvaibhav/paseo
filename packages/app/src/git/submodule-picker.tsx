import { useCallback, useMemo, useState, memo, useRef } from "react";
import { View, Text, Pressable, ScrollView, Modal } from "react-native";
import { ChevronDown, FolderGit2, Circle } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { SubmoduleInfo } from "./use-submodules-query";

interface SubmodulePickerProps {
  submodules: SubmoduleInfo[];
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}

export function SubmodulePicker({ submodules, selectedPath, onSelect }: SubmodulePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<View>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, right: 0 });

  const toggle = useCallback(() => {
    if (!isOpen && triggerRef.current) {
      triggerRef.current.measureInWindow((x, y, width, height) => {
        setDropdownPosition({ top: y + height + 2, right: window.innerWidth - (x + width) });
        setIsOpen(true);
      });
    } else {
      setIsOpen(false);
    }
  }, [isOpen]);

  const close = useCallback(() => setIsOpen(false), []);

  const selectedLabel = selectedPath
    ? (submodules.find((s) => s.path === selectedPath)?.name ?? lastPathSegment(selectedPath))
    : "root";

  const handleSelect = useCallback(
    (path: string | null) => {
      onSelect(path);
      close();
    },
    [onSelect, close],
  );

  const handleSelectRoot = useCallback(() => handleSelect(null), [handleSelect]);

  const dropdownStyle = useMemo(
    () => [pickerStyles.dropdown, { top: dropdownPosition.top, right: dropdownPosition.right }],
    [dropdownPosition.top, dropdownPosition.right],
  );

  return (
    <View ref={triggerRef} style={pickerStyles.container}>
      <Pressable onPress={toggle} style={pickerStyles.trigger}>
        {({ hovered }) => (
          <>
            <FolderGit2
              size={13}
              color={hovered ? pickerStyles.triggerIcon.hoverColor : pickerStyles.triggerIcon.color}
            />
            <Text
              style={hovered ? pickerStyles.triggerTextHovered : pickerStyles.triggerText}
              numberOfLines={1}
            >
              {selectedLabel}
            </Text>
            <ChevronDown
              size={11}
              color={hovered ? pickerStyles.triggerIcon.hoverColor : pickerStyles.triggerIcon.color}
            />
          </>
        )}
      </Pressable>
      {isOpen && (
        <Modal transparent visible onRequestClose={close}>
          <Pressable style={pickerStyles.backdrop} onPress={close} />
          <View style={dropdownStyle}>
            <ScrollView style={pickerStyles.scrollArea} bounces={false}>
              <SubmoduleRow
                label="root"
                depth={0}
                isSelected={selectedPath === null}
                status="clean"
                onSelect={handleSelectRoot}
              />
              {renderTree(submodules, 0, selectedPath, handleSelect)}
            </ScrollView>
          </View>
        </Modal>
      )}
    </View>
  );
}

function renderTree(
  nodes: SubmoduleInfo[],
  depth: number,
  selectedPath: string | null,
  onSelect: (path: string | null) => void,
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  for (const node of nodes) {
    result.push(
      <SubmoduleRowWithHandler
        key={node.path}
        node={node}
        depth={depth + 1}
        isSelected={selectedPath === node.path}
        onSelect={onSelect}
      />,
    );
    if (node.children.length > 0) {
      result.push(...renderTree(node.children, depth + 1, selectedPath, onSelect));
    }
  }
  return result;
}

interface SubmoduleRowWithHandlerProps {
  node: SubmoduleInfo;
  depth: number;
  isSelected: boolean;
  onSelect: (path: string | null) => void;
}

const SubmoduleRowWithHandler = memo(function SubmoduleRowWithHandler({
  node,
  depth,
  isSelected,
  onSelect,
}: SubmoduleRowWithHandlerProps) {
  const handleSelect = useCallback(() => onSelect(node.path), [onSelect, node.path]);
  return (
    <SubmoduleRow
      label={node.name}
      depth={depth}
      isSelected={isSelected}
      status={node.status}
      headRef={node.headRef}
      onSelect={handleSelect}
    />
  );
});

interface SubmoduleRowProps {
  label: string;
  depth: number;
  isSelected: boolean;
  status: "clean" | "dirty" | "uninitialized";
  headRef?: string | null;
  onSelect: () => void;
}

const SubmoduleRow = memo(function SubmoduleRow({
  label,
  depth,
  isSelected,
  status,
  headRef,
  onSelect,
}: SubmoduleRowProps) {
  const rowStyle = useMemo(() => [pickerStyles.row, { paddingLeft: 8 + depth * 14 }], [depth]);
  const labelStyle = useMemo(
    () => (isSelected ? pickerStyles.rowLabelSelected : pickerStyles.rowLabel),
    [isSelected],
  );

  return (
    <Pressable onPress={onSelect} style={rowStyle}>
      {({ hovered }) => (
        <View style={hovered ? pickerStyles.rowInnerHovered : pickerStyles.rowInner}>
          <Text style={labelStyle} numberOfLines={1}>
            {label}
          </Text>
          {headRef && (
            <Text style={pickerStyles.rowBranch} numberOfLines={1}>
              {headRef}
            </Text>
          )}
          {status === "dirty" && (
            <Circle
              size={6}
              fill={pickerStyles.dirtyDot.color}
              color={pickerStyles.dirtyDot.color}
            />
          )}
        </View>
      )}
    </Pressable>
  );
});

function lastPathSegment(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

const pickerStyles = StyleSheet.create((theme) => ({
  container: {},
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  triggerIcon: {
    color: theme.colors.foregroundMuted,
    hoverColor: theme.colors.foreground,
  },
  triggerText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    maxWidth: 120,
  },
  triggerTextHovered: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    maxWidth: 120,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  dropdown: {
    position: "absolute",
    minWidth: 240,
    maxHeight: 400,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    ...(isWeb
      ? ({
          boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
        } as object)
      : {
          shadowColor: "#000",
          shadowOpacity: 0.25,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 4 },
        }),
    overflow: "hidden",
  },
  scrollArea: {
    maxHeight: 400,
    paddingVertical: theme.spacing[1],
  },
  row: {
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  rowInnerHovered: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 1,
    minWidth: 0,
  },
  rowLabelSelected: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
    minWidth: 0,
  },
  rowBranch: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  dirtyDot: {
    color: theme.colors.statusWarning,
  },
}));
