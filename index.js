import {
    eventSource,
    event_types,
    chat,
    chatElement,
    isGenerating,
    updateViewMessageIds,
    refreshSwipeButtons,
    saveChatConditional,
} from "../../../../script.js";
import { swapItemizedPrompts } from "../../../../scripts/itemized-prompts.js";

const extensionName = "rearrange-messages";

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function buildListHtml() {
    return chat
        .map((msg, idx) => {
            const name = escapeHtml(
                msg.name || (msg.is_user ? "You" : "Character")
            );
            const rawText = (msg.mes || "").replace(/<[^>]+>/g, "").trim();
            const preview = escapeHtml(rawText.substring(0, 100));
            const ellipsis = rawText.length > 100 ? "…" : "";
            const roleClass = msg.is_user
                ? "rearrange-user"
                : msg.is_system
                ? "rearrange-system"
                : "rearrange-char";
            const roleIcon = msg.is_user
                ? "fa-user"
                : msg.is_system
                ? "fa-gear"
                : "fa-robot";
            return `<li class="rearrange-item ${roleClass}" data-mesid="${idx}">
                <span class="rearrange-handle fa-solid fa-grip-vertical" title="Drag to reorder"></span>
                <span class="rearrange-role-icon fa-solid ${roleIcon}"></span>
                <span class="rearrange-name">${name}</span>
                <span class="rearrange-preview">${preview}${ellipsis}</span>
                <span class="rearrange-index">#${idx}</span>
            </li>`;
        })
        .join("");
}

function openRearrangePanel() {
    // Close the options menu
    $("#options").hide();

    // Remove any pre-existing panel
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
                    Drag messages by the grip handle to reorder, then click Apply.
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

    // Make the list sortable with jQuery UI
    $("#rearrange_list").sortable({
        handle: ".rearrange-handle",
        placeholder: "rearrange-placeholder",
        axis: "y",
        tolerance: "pointer",
        start(_, ui) {
            ui.placeholder.height(ui.item.outerHeight());
        },
    });

    // Button handlers
    $("#rearrange_close, #rearrange_cancel").on("click", closeRearrangePanel);

    $("#rearrange_overlay").on("click", function (e) {
        if (e.target === this) closeRearrangePanel();
    });

    $("#rearrange_reset").on("click", () => {
        // Rebuild the list in original order
        $("#rearrange_list").sortable("destroy");
        $("#rearrange_list").html(buildListHtml());
        $("#rearrange_list").sortable({
            handle: ".rearrange-handle",
            placeholder: "rearrange-placeholder",
            axis: "y",
            tolerance: "pointer",
            start(_, ui) {
                ui.placeholder.height(ui.item.outerHeight());
            },
        });
    });

    $("#rearrange_apply").on("click", async () => {
        const btn = $("#rearrange_apply");
        btn.prop("disabled", true).text("Applying…");
        try {
            await applyRearrange();
            closeRearrangePanel();
            toastr.success("Messages rearranged.");
        } catch (err) {
            console.error(`[${extensionName}] Error applying rearrange:`, err);
            toastr.error("Failed to rearrange messages.");
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

/**
 * Swap two adjacent messages (lowerIdx < higherIdx, higherIdx === lowerIdx + 1).
 * Replicates the logic of messageEditMove() in script.js.
 */
function doAdjacentSwap(lowerIdx, higherIdx) {
    const lowerEl = chatElement.find(`.mes[mesid="${lowerIdx}"]`);
    const higherEl = chatElement.find(`.mes[mesid="${higherIdx}"]`);

    if (!lowerEl.length || !higherEl.length) return;

    // Notify collapse-messages (and any other listeners) before the swap.
    // collapse-messages listens on mousedown of .mes_edit_down on the lower element
    // which maps fromId=lowerIdx, toId=lowerIdx+1=higherIdx — exactly what we're doing.
    lowerEl.find(".mes_edit_down").trigger("mousedown");

    // DOM swap: lower element moves after higher element
    lowerEl.insertAfter(higherEl);

    // Update mesid attributes
    lowerEl.attr("mesid", higherIdx);
    higherEl.attr("mesid", lowerIdx);

    // Swap in the chat array
    [chat[lowerIdx], chat[higherIdx]] = [chat[higherIdx], chat[lowerIdx]];

    // Swap itemized prompts (for token counting accuracy)
    swapItemizedPrompts(lowerIdx, higherIdx);
}

async function applyRearrange() {
    // Read the desired new order from the panel DOM
    const newOrder = [];
    $("#rearrange_list .rearrange-item").each(function () {
        newOrder.push(parseInt($(this).data("mesid")));
    });

    if (isGenerating()) {
        throw new Error("Cannot rearrange while a response is generating.");
    }

    const n = chat.length;

    if (newOrder.length !== n) {
        throw new Error(
            `Message count mismatch: panel has ${newOrder.length}, chat has ${n}`
        );
    }

    // Quick identity check
    if (newOrder.every((id, idx) => id === idx)) return;

    // Validate: must be a permutation of 0..n-1
    const seen = new Set(newOrder);
    if (seen.size !== n || !newOrder.every((id) => id >= 0 && id < n)) {
        throw new Error("Invalid permutation in rearrange panel.");
    }

    // Apply the permutation using selection sort (only adjacent swaps).
    //
    // We maintain:
    //   current[i]  = original mesid currently at DOM/array position i
    //   pos[origId] = current position of the message with that original mesid
    //
    // For each target position i (0..n-1), we find where newOrder[i] currently is
    // and bubble it left to position i via adjacent swaps.

    const current = Array.from({ length: n }, (_, i) => i);
    const pos = Array.from({ length: n }, (_, i) => i);

    for (let i = 0; i < n; i++) {
        const targetOrig = newOrder[i];
        let j = pos[targetOrig];

        while (j > i) {
            const idA = current[j - 1];
            const idB = current[j];

            doAdjacentSwap(j - 1, j);

            // Update tracking structures
            current[j - 1] = idB;
            current[j] = idA;
            pos[idB] = j - 1;
            pos[idA] = j;

            j--;
        }
    }

    updateViewMessageIds();
    refreshSwipeButtons();
    await saveChatConditional();
}

jQuery(async () => {
    // Inject the "Rearrange Messages" entry into the hamburger options menu.
    // We insert it just before the <hr> that precedes the Delete/Regenerate/Continue block.
    const menuItem = $(`
        <a id="option_rearrange_messages">
            <i class="fa-lg fa-solid fa-arrows-up-down"></i>
            <span>Rearrange Messages</span>
        </a>
    `);
    menuItem.on("click", openRearrangePanel);

    const deleteOption = $("#option_delete_mes");
    if (deleteOption.length) {
        // Find the <hr> immediately before it and insert before that
        const prevHr = deleteOption.prev("hr");
        if (prevHr.length) {
            menuItem.insertBefore(prevHr);
        } else {
            menuItem.insertBefore(deleteOption);
        }
    } else {
        $("#options .options-content").append(menuItem);
    }

    // Close the rearrange panel when the chat changes so stale state doesn't persist
    eventSource.on(event_types.CHAT_CHANGED, closeRearrangePanel);
});
