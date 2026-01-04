import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquare, Sparkles, Trash2, Copy, Check } from './icons';
import { Conversation } from '../types';
import { getRecentConversations, deleteConversation } from '../hooks/useTauri';

interface ConversationHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  currentConversationId: string | null;
  onSelectConversation: (conversationId: string) => Promise<void>;
  onReopenConversation: (conversationId: string) => Promise<void>;
}

export function ConversationHistory({ 
  isOpen, 
  onClose, 
  currentConversationId,
  onSelectConversation: _onSelectConversation,
  onReopenConversation,
}: ConversationHistoryProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    setIsLoading(true);
    try {
      const convs = await getRecentConversations(50);
      setConversations(convs);
    } catch (err) {
      console.error('Failed to load conversations:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load conversations when modal opens
  useEffect(() => {
    if (isOpen) {
      loadConversations();
      setSelectedId(null);
    }
  }, [isOpen]);

  const handleDeleteClick = useCallback((conversationId: string) => {
    setDeleteConfirmId(conversationId);
  }, []);

  const handleDeleteConfirm = useCallback(async (conversationId: string) => {
    try {
      await deleteConversation(conversationId);
      // Reload conversations from backend to ensure consistency
      await loadConversations();
      setSelectedId(prev => prev === conversationId ? null : prev);
      setDeleteConfirmId(null);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      setDeleteConfirmId(null);
    }
  }, [loadConversations]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteConfirmId(null);
  }, []);

  const handleCopy = useCallback(async (conversationId: string) => {
    setConversations(convs => {
      const conv = convs.find(c => c.id === conversationId);
      if (conv) {
        const text = conv.title || conv.summary || conversationId;
        navigator.clipboard.writeText(text).then(() => {
          setCopiedId(conversationId);
          setTimeout(() => setCopiedId(null), 2000);
        }).catch(err => {
          console.error('Failed to copy:', err);
        });
      }
      return convs;
    });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Handle delete confirmation modal
      if (deleteConfirmId) {
        if (e.key === 'Escape') {
          e.preventDefault();
          handleDeleteCancel();
          return;
        }
        if (e.key === 'End') {
          e.preventDefault();
          handleDeleteConfirm(deleteConfirmId);
          return;
        }
        return; // Don't handle other keys when confirmation modal is open
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (!selectedId) return;

      // Only respond to single key presses (no modifiers)
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (e.key === 'd' || e.key === 'D') {
          e.preventDefault();
          handleDeleteClick(selectedId);
        } else if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          handleCopy(selectedId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedId, deleteConfirmId, handleDeleteClick, handleDeleteConfirm, handleDeleteCancel, handleCopy, onClose]);

  const formatDate = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  };

  const handleSelectConversation = async (conversation: Conversation) => {
    if (conversation.id === currentConversationId) {
      onClose();
      return;
    }
    
    setSelectedId(conversation.id);
  };

  const handleReopenConversation = async (conversationId: string) => {
    try {
      await onReopenConversation(conversationId);
      onClose();
    } catch (err) {
      console.error('Failed to reopen conversation:', err);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop - with rounded corners to match window */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-void/60 backdrop-blur-sm z-40 rounded-xl overflow-hidden"
          />

          {/* Floating Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed left-2 top-2 bottom-2 w-80 bg-obsidian/98 backdrop-blur-xl border border-smoke/40 rounded-2xl z-50 flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-smoke/30 flex-shrink-0">
              <div className="inline-flex px-2.5 py-1 rounded-full bg-smoke/20 border border-smoke/40">
                <h2 className="font-sans text-xs text-pearl font-medium uppercase tracking-wider">
                  HISTORY
                </h2>
              </div>
              <button
                onClick={onClose}
                className="px-2 py-1 rounded text-[9px] font-sans text-ash bg-smoke/30 hover:bg-smoke/50 border border-smoke/50 transition-colors cursor-pointer flex items-center justify-center"
                title="Close (Esc)"
              >
                ESC
              </button>
            </div>

            {/* Content */}
            <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3">
              {isLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-ash/50 text-xs font-sans">Loading...</div>
                </div>
              ) : conversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <MessageSquare className="w-8 h-8 text-ash/30 mb-2" strokeWidth={1.5} />
                  <div className="text-ash/50 text-xs font-sans">No conversations yet</div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {conversations.map((conv) => {
                    const isActive = conv.id === currentConversationId;
                    const isSelected = selectedId === conv.id;
                    const title = conv.title || conv.summary || 'New conversation';
                    const preview = conv.summary || (conv.title ? null : 'No messages yet');
                    
                    return (
                      <div
                        key={conv.id}
                        className={`group/item relative rounded-lg border transition-all ${
                          isActive
                            ? 'bg-smoke/30 border-smoke/50'
                            : isSelected
                            ? 'bg-smoke/20 border-smoke/40'
                            : 'bg-smoke/10 border-smoke/20 hover:bg-smoke/15 hover:border-smoke/30'
                        }`}
                      >
                        <motion.button
                          onClick={() => handleSelectConversation(conv)}
                          onDoubleClick={() => handleReopenConversation(conv.id)}
                          className="w-full text-left px-3 py-2.5"
                          whileHover={{ scale: 1.01 }}
                          whileTap={{ scale: 0.99 }}
                        >
                          <div className="flex items-start gap-2">
                            {/* Disco indicator */}
                            {conv.isDisco && (
                              <div className="flex-shrink-0 mt-0.5">
                                <Sparkles className="w-3 h-3 text-amber-400" strokeWidth={2} />
                              </div>
                            )}
                            
                            <div className="flex-1 min-w-0">
                              {/* Title */}
                              <div className="flex items-center gap-2 mb-1">
                                <div 
                                  className={`inline-block px-2 py-0.5 rounded-full text-xs font-sans truncate max-w-full ${
                                    isActive 
                                      ? 'bg-smoke/30 text-pearl border border-smoke/50' 
                                      : 'bg-smoke/20 text-ash/80 border border-smoke/30'
                                  }`}
                                >
                                  {title}
                                </div>
                                {isActive && (
                                  <div className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                )}
                              </div>
                              
                              {/* Preview */}
                              {preview && (
                                <div className="text-[10px] text-ash/50 font-sans line-clamp-2 mb-1">
                                  {preview}
                                </div>
                              )}
                              
                              {/* Date and action buttons row */}
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[9px] text-ash/40 font-sans">
                                  {formatDate(conv.updatedAt)}
                                </div>
                                
                                {/* Action buttons - show on hover, smaller and inline */}
                                <div className="flex items-center gap-0.5 opacity-0 group-hover/item:opacity-100 transition-opacity duration-200">
                                  {/* Copy button */}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCopy(conv.id);
                                    }}
                                    className="flex items-center gap-1 px-1.5 py-1 rounded border border-smoke/40 bg-obsidian/95 backdrop-blur-sm hover:bg-smoke/30 text-ash/70 hover:text-ivory transition-all"
                                    title="Copy (C)"
                                  >
                                    {copiedId === conv.id ? (
                                      <Check className="w-2.5 h-2.5" strokeWidth={2} />
                                    ) : (
                                      <Copy className="w-2.5 h-2.5" strokeWidth={2} />
                                    )}
                                    <kbd className="text-[8px] font-sans text-ash/50">C</kbd>
                                  </button>
                                  
                                  {/* Delete button */}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteClick(conv.id);
                                    }}
                                    className="flex items-center gap-1 px-1.5 py-1 rounded border border-red-500/40 bg-obsidian/95 backdrop-blur-sm hover:bg-red-500/30 text-red-400 hover:text-red-300 transition-all"
                                    title="Delete (D)"
                                  >
                                    <Trash2 className="w-2.5 h-2.5" strokeWidth={2} />
                                    <kbd className="text-[8px] font-sans text-red-400/70">D</kbd>
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </motion.button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer with keyboard hints */}
            {selectedId && !deleteConfirmId && (
              <div className="px-4 py-2 border-t border-smoke/30 flex items-center justify-between text-[10px] text-ash/50 font-sans">
                <div className="flex items-center gap-3">
                  <span>Double-click to reopen</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 bg-smoke/30 rounded border border-smoke/40">C</kbd>
                    <span>Copy</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 bg-smoke/30 rounded border border-smoke/40">D</kbd>
                    <span>Delete</span>
                  </span>
                </div>
              </div>
            )}
          </motion.div>

          {/* Delete Confirmation Modal */}
          <AnimatePresence>
            {deleteConfirmId && (
              <>
                {/* Backdrop - with rounded corners to match window */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={handleDeleteCancel}
                  className="fixed inset-0 bg-void/80 backdrop-blur-sm z-[60] rounded-xl overflow-hidden"
                />

                {/* Modal */}
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 20 }}
                  transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                  className="fixed inset-0 flex items-center justify-center z-[70] pointer-events-none p-8"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="w-full max-w-xs bg-obsidian/98 backdrop-blur-xl border border-smoke/40 rounded-xl shadow-2xl pointer-events-auto overflow-hidden">
                    {/* Content */}
                    <div className="px-4 py-4">
                      <h3 className="text-sm font-sans font-medium text-pearl mb-4">
                        Delete conversation?
                      </h3>

                      {/* Actions */}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={handleDeleteCancel}
                          className="px-3 py-1.5 rounded-md border border-smoke/40 bg-smoke/20 hover:bg-smoke/30 text-ash/80 hover:text-pearl transition-colors text-xs font-sans flex items-center gap-1.5"
                        >
                          Cancel
                          <kbd className="px-1 py-0.5 bg-smoke/30 rounded border border-smoke/40 text-[9px]">ESC</kbd>
                        </button>
                        <button
                          onClick={() => handleDeleteConfirm(deleteConfirmId)}
                          className="px-3 py-1.5 rounded-md border border-red-500/40 bg-red-500/20 hover:bg-red-500/30 text-red-400 hover:text-red-300 transition-colors text-xs font-sans flex items-center gap-1.5"
                        >
                          Delete
                          <kbd className="px-1 py-0.5 bg-red-500/30 rounded border border-red-500/40 text-[9px]">END</kbd>
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}
