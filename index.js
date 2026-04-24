import { extension_settings } from "../../../extensions.js";
import {
    eventSource,
    event_types,
    chat,
    chat_metadata,
    chatElement,
    isGenerating,
    getCurrentChatId,
    updateViewMessageIds,
    refreshSwipeButtons,
    saveChatConditional,
    saveSettingsDebounced,
} from "../../../../script.js";
import {
    swapItemizedPrompts,
    deleteItemizedPromptForMessage,
} from "../../../../scripts/itemized-prompts.js";

const extensionName = "rearrange-messages";

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function hasCollapseExtension() {
    const s = extension_settings["collapse-messages"];
    return s != null && s.collapsed != null;
}

function isMessageCollapsed(mesId) {
    const chatId = getCurrentChatId();
    if (!chatId) return false;
    const arr = extension_settings["collapse-messages"]?.collapsed?.[chatId];
    return Array.isArray(arr) && arr.includes(mesId);
}

function buildListHtml() {
    const showCollapse = hasCollapseExtension();
    return chat
        .map((msg, idx) => {
            const name = escapeHtml(
                msg.name || (msg.is_user ? "You" : "Character")
            );
            const rawText = (msg.mes || "").replace(/<[^>]+>/g, "").trim();
            const preview = escapeHtml(rawText.substring(0, 100));
            const ellipsis = rawText.length > 100 ? "…" : "";
            const isUser = !!msg.is_user;
            const isSystem = !!msg.is_system;
            const roleClass = isSystem ? "rearrange-system" : isUser ? "rearrange-user" : "rearrange-char";
            const dataRole = isUser ? "user" : "char";
            // Static role icon (user / character — original type, display only)
            const roleIcon = isUser ? "fa-user" : "fa-robot";
            // Eye button: fa-eye = included in prompt, fa-eye-slash = excluded (is_system)
            // data-system stores the pending is_system value
            const eyeIcon = isSystem ? "fa-eye-slash" : "fa-eye";
            const eyeTitle = isSystem ? "Excluded from prompt — click to include" : "Included in prompt — click to exclude";
            const eyeBtn = `<button class="rearrange-eye-btn fa-solid ${eyeIcon}" data-system="${isSystem}" title="${eyeTitle}"></button>`;
            return `<li class="rearrange-item ${roleClass}" data-mesid="${idx}" data-role="${dataRole}">
                <span class="rearrange-handle fa-solid fa-grip-vertical" title="Drag to reorder"></span>
                <span class="rearrange-role-icon fa-solid ${roleIcon}"></span>
                ${eyeBtn}
                <span class="rearrange-name">${name}</span>
                <span class="rearrange-preview">${preview}${ellipsis}</span>
                <span class="rearrange-index">#${idx}</span>
                ${showCollapse ? (() => {
                    const collapsed = isMessageCollapsed(idx);
                    return `<button class="rearrange-collapse-btn fa-solid ${collapsed ? "fa-compress" : "fa-expand"}" data-collapsed="${collapsed}" title="${collapsed ? "Collapsed — click to expand" : "Expanded — click to collapse"}"></button>`;
                })() : ""}
                <button class="rearrange-delete-btn fa-solid fa-trash" title="Mark for deletion"></button>
            </li>`;
        })
        .join("");
}

function makeSortable() {
    $("#rearrange_list").sortable({
        handle: ".rearrange-handle",
        placeholder: "rearrange-placeholder",
        axis: "y",
        tolerance: "pointer",
        // Don't drag items marked for deletion
        filter: ".rearrange-deleted",
        cancel: ".rearrange-deleted .rearrange-handle, .rearrange-delete-btn",
        start(_, ui) {
            ui.placeholder.height(ui.item.outerHeight());
        },
    });
}

function bindTypeButtons(container) {
    container.on("click", ".rearrange-eye-btn", function (e) {
        e.stopPropagation();
        const btn = $(this);
        const item = btn.closest(".rearrange-item");
        const wasSystem = btn.data("system") === true || btn.data("system") === "true";
        const nowSystem = !wasSystem;
        btn.data("system", nowSystem)
            .toggleClass("fa-eye-slash", nowSystem)
            .toggleClass("fa-eye", !nowSystem)
            .attr("title", nowSystem
                ? "Excluded from prompt — click to include"
                : "Included in prompt — click to exclude");
        if (nowSystem) {
            item.removeClass("rearrange-user rearrange-char").addClass("rearrange-system");
        } else {
            const origRole = item.data("role");
            item.removeClass("rearrange-system").addClass(origRole === "user" ? "rearrange-user" : "rearrange-char");
        }
    });
}

function bindCollapseButtons(container) {
    container.on("click", ".rearrange-collapse-btn", function (e) {
        e.stopPropagation();
        const btn = $(this);
        const wasCollapsed = btn.data("collapsed") === true || btn.data("collapsed") === "true";
        const nowCollapsed = !wasCollapsed;
        btn.data("collapsed", nowCollapsed)
            .toggleClass("fa-compress", nowCollapsed)
            .toggleClass("fa-expand", !nowCollapsed)
            .attr("title", nowCollapsed ? "Collapsed — click to expand" : "Expanded — click to collapse");
    });
}

function bindDeleteButtons(container) {
    container.on("click", ".rearrange-delete-btn", function (e) {
        e.stopPropagation();
        const item = $(this).closest(".rearrange-item");
        const isNowDeleted = !item.hasClass("rearrange-deleted");
        item.toggleClass("rearrange-deleted", isNowDeleted);
        $(this)
            .toggleClass("fa-trash", !isNowDeleted)
            .toggleClass("fa-rotate-left", isNowDeleted)
            .attr("title", isNowDeleted ? "Unmark deletion" : "Mark for deletion");
    });
}

function openRearrangePanel() {
    $("#options").hide();
    closeRearrangePanel();

    if (!chat || chat.length === 0) {
        toastr.info("No messages to rearrange.");
        return;
    }

    if (isGenerating()) {
        toastr.warning("Cannot rearrange messages while a response is generating.");
        return;
    }

    const panel = $(`
        <div id="rearrange_overlay">
            <div id="rearrange_panel" class="font-family-reset">
                <div id="rearrange_header">
                    <i class="fa-solid fa-arrows-up-down"></i>
                    <span>Rearrange Messages</span>
                    <button id="rearrange_close" class="rearrange-icon-btn fa-solid fa-times" title="Cancel"></button>
                </div>
                <div id="rearrange_hint">
                    <i class="fa-solid fa-circle-info"></i>
                    Drag to reorder. <i class="fa-solid fa-eye"></i> prompt. <i class="fa-solid fa-compress"></i> collapse. <i class="fa-solid fa-trash"></i> delete.
                </div>
                <ul id="rearrange_list">${buildListHtml()}</ul>
                <div id="rearrange_footer">
                    <button id="rearrange_reset" class="menu_button">Reset</button>
                    <div class="rearrange-footer-right">
                        <button id="rearrange_cancel" class="menu_button">Cancel</button>
                        <button id="rearrange_apply" class="menu_button menu_button_primary">Apply</button>
                    </div>
                </div>
            </div>
        </div>
    `);

    $("body").append(panel);

    makeSortable();
    bindTypeButtons($("#rearrange_list"));
    bindCollapseButtons($("#rearrange_list"));
    bindDeleteButtons($("#rearrange_list"));

    $("#rearrange_close, #rearrange_cancel").on("click", closeRearrangePanel);


    $("#rearrange_reset").on("click", () => {
        const list = $("#rearrange_list");
        if (list.data("ui-sortable")) list.sortable("destroy");
        list.html(buildListHtml());
        makeSortable();
        bindTypeButtons(list);
        bindCollapseButtons(list);
        bindDeleteButtons(list);
    });

    $("#rearrange_apply").on("click", async () => {
        const btn = $("#rearrange_apply");
        btn.prop("disabled", true).text("Applying…");
        try {
            const { deleted, reordered, typeChanged } = await applyRearrange();
            closeRearrangePanel();
            const parts = [];
            if (deleted > 0) parts.push(`${deleted} deleted`);
            if (reordered) parts.push("reordered");
            if (typeChanged > 0) parts.push(`${typeChanged} type${typeChanged > 1 ? "s" : ""} changed`);
            toastr.success(parts.length ? parts.join(", ") + "." : "No changes.");
        } catch (err) {
            console.error(`[${extensionName}] Error:`, err);
            toastr.error(err.message || "Failed to apply changes.");
            btn.prop("disabled", false).text("Apply");
        }
    });
}

function closeRearrangePanel() {
    const list = $("#rearrange_list");
    if (list.length && list.data("ui-sortable")) {
        list.sortable("destroy");
    }
    $("#rearrange_overlay").remove();
}

// ---------------------------------------------------------------------------
// Core: adjacent swap
// ---------------------------------------------------------------------------

/**
 * Swap two adjacent messages (lowerIdx < higherIdx, higherIdx === lowerIdx + 1).
 * Replicates the logic of messageEditMove() in script.js.
 */
function doAdjacentSwap(lowerIdx, higherIdx) {
    const lowerEl = chatElement.find(`.mes[mesid="${lowerIdx}"]`);
    const higherEl = chatElement.find(`.mes[mesid="${higherIdx}"]`);

    if (!lowerEl.length || !higherEl.length) return;

    // Notify collapse-messages before the DOM swap.
    // Its handler reads mesid from the element (still lowerIdx here) and
    // computes toId = lowerIdx + 1 = higherIdx, which is exactly the swap we're doing.
    lowerEl.find(".mes_edit_down").trigger("mousedown");

    lowerEl.insertAfter(higherEl);

    lowerEl.attr("mesid", higherIdx);
    higherEl.attr("mesid", lowerIdx);

    [chat[lowerIdx], chat[higherIdx]] = [chat[higherIdx], chat[lowerIdx]];

    swapItemizedPrompts(lowerIdx, higherIdx);
}

// ---------------------------------------------------------------------------
// Core: delete a single message by its current mesid
// ---------------------------------------------------------------------------

/**
 * Delete one message.  We replicate what ST's deleteMessage() does but fire
 * MESSAGE_DELETED with the actual deleted id (not chat.length), so that
 * collapse-messages correctly removes/decrements its collapsed-ids array.
 *
 * Call in descending mesid order so lower ids are never shifted before deletion.
 */
async function doDeleteMessage(mesId) {
    const messageElement = chatElement.find(`.mes[mesid="${mesId}"]`);
    if (!messageElement.length) return;

    chat.splice(mesId, 1);
    messageElement.remove();

    chat_metadata.tainted = true;

    deleteItemizedPromptForMessage(mesId);

    // Fire with the real deleted id so listeners (e.g. collapse-messages)
    // correctly remove that id and decrement higher ones.
    await eventSource.emit(event_types.MESSAGE_DELETED, mesId);
}

// ---------------------------------------------------------------------------
// Apply: deletions first, then reorder
// ---------------------------------------------------------------------------

async function applyRearrange() {
    if (isGenerating()) {
        throw new Error("Cannot apply changes while a response is generating.");
    }

    // Collect which original mesids are marked for deletion
    const toDelete = new Set();
    $("#rearrange_list .rearrange-item.rearrange-deleted").each(function () {
        toDelete.add(parseInt($(this).data("mesid")));
    });

    // Collect desired final order of remaining messages (by original mesid)
    const newOrderOriginal = [];
    $("#rearrange_list .rearrange-item:not(.rearrange-deleted)").each(function () {
        newOrderOriginal.push(parseInt($(this).data("mesid")));
    });

    if (toDelete.size === 0 && newOrderOriginal.length === 0) {
        throw new Error("No messages left — cannot delete everything.");
    }

    if (toDelete.size > 0 && newOrderOriginal.length === 0) {
        throw new Error("Cannot delete all messages.");
    }

    const n = chat.length;

    // Validate newOrderOriginal is a subset permutation of 0..n-1
    if (toDelete.size + newOrderOriginal.length !== n) {
        throw new Error("Message count mismatch. Please close and reopen the panel.");
    }

    // ── Step 1: deletions (descending order so lower ids stay stable) ──────

    const sortedDeletes = Array.from(toDelete).sort((a, b) => b - a);
    for (const mesId of sortedDeletes) {
        await doDeleteMessage(mesId);
    }

    // ── Step 2: remap original mesids → post-deletion mesids ───────────────
    //
    // For each surviving original mesid, its new id is:
    //   origId - (number of deleted ids that were strictly below it)

    const deletedSorted = Array.from(toDelete).sort((a, b) => a - b);

    function remapId(origId) {
        let shift = 0;
        for (const d of deletedSorted) {
            if (d < origId) shift++;
            else break;
        }
        return origId - shift;
    }

    const newOrder = newOrderOriginal.map(remapId);
    const m = newOrder.length; // surviving message count

    // ── Step 3: reorder surviving messages ─────────────────────────────────

    // Quick identity check
    const unchanged = newOrder.every((id, idx) => id === idx);

    if (!unchanged) {
        // Validate: must be a permutation of 0..m-1
        const seen = new Set(newOrder);
        if (seen.size !== m || !newOrder.every((id) => id >= 0 && id < m)) {
            throw new Error("Internal error: invalid post-deletion permutation.");
        }

        // Selection sort via adjacent swaps
        const current = Array.from({ length: m }, (_, i) => i);
        const pos = Array.from({ length: m }, (_, i) => i);

        for (let i = 0; i < m; i++) {
            const targetOrig = newOrder[i];
            let j = pos[targetOrig];

            while (j > i) {
                const idA = current[j - 1];
                const idB = current[j];

                doAdjacentSwap(j - 1, j);

                current[j - 1] = idB;
                current[j] = idA;
                pos[idB] = j - 1;
                pos[idA] = j;

                j--;
            }
        }
    }

    // ── Step 4: apply any is_system flips ──────────────────────────────────
    // After deletions + reorder, the surviving items are now at their final mesids.
    // Walk the (non-deleted) panel rows in their final order to read pending flips.
    let typeChanged = 0;
    $("#rearrange_list .rearrange-item:not(.rearrange-deleted)").each(function (finalIdx) {
        const btn = $(this).find(".rearrange-eye-btn");
        if (!btn.length) return;
        const pendingSystem = btn.data("system") === true || btn.data("system") === "true";
        if (chat[finalIdx].is_system !== pendingSystem) {
            chat[finalIdx].is_system = pendingSystem;
            chatElement.find(`.mes[mesid="${finalIdx}"]`).attr("is_system", String(pendingSystem));
            typeChanged++;
        }
    });

    // ── Step 5: apply collapse state changes (if collapse-messages is active) ─
    if (hasCollapseExtension()) {
        const chatId = getCurrentChatId();
        if (chatId) {
            const collapseSettings = extension_settings["collapse-messages"];
            if (!collapseSettings.collapsed[chatId]) collapseSettings.collapsed[chatId] = [];
            const arr = collapseSettings.collapsed[chatId];

            $("#rearrange_list .rearrange-item:not(.rearrange-deleted)").each(function (finalIdx) {
                const btn = $(this).find(".rearrange-collapse-btn");
                if (!btn.length) return;

                const pendingCollapsed = btn.data("collapsed") === true || btn.data("collapsed") === "true";
                const currentlyCollapsed = arr.includes(finalIdx);

                if (pendingCollapsed === currentlyCollapsed) return;

                if (pendingCollapsed) {
                    arr.push(finalIdx);
                } else {
                    arr.splice(arr.indexOf(finalIdx), 1);
                }

                // Update the live message visuals
                const mesEl = chatElement.find(`.mes[mesid="${finalIdx}"]`);
                mesEl.find(".mes_text").toggleClass("mes_text_collapsed", pendingCollapsed);
                mesEl.find(".mes_collapse_btn")
                    .toggleClass("fa-compress", !pendingCollapsed)
                    .toggleClass("fa-expand", pendingCollapsed)
                    .attr("title", pendingCollapsed ? "Expand message" : "Collapse message");
            });

            saveSettingsDebounced();
        }
    }

    updateViewMessageIds();
    refreshSwipeButtons();
    await saveChatConditional();

    return { deleted: sortedDeletes.length, reordered: !unchanged, typeChanged };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

jQuery(async () => {
    const menuItem = $(`
        <a id="option_rearrange_messages">
            <i class="fa-lg fa-solid fa-arrows-up-down"></i>
            <span>Rearrange Messages</span>
        </a>
    `);
    menuItem.on("click", openRearrangePanel);

    const deleteOption = $("#option_delete_mes");
    if (deleteOption.length) {
        const prevHr = deleteOption.prev("hr");
        if (prevHr.length) {
            menuItem.insertBefore(prevHr);
        } else {
            menuItem.insertBefore(deleteOption);
        }
    } else {
        $("#options .options-content").append(menuItem);
    }

    eventSource.on(event_types.CHAT_CHANGED, closeRearrangePanel);
});
