// Small DOM helpers.
//
// The rule these exist to enforce: cluster data goes on the page as text,
// never as HTML. Nothing here takes a string of markup -- there is no
// innerHTML anywhere in src/ except in `svg()`, which is only ever handed the
// icon constants in parts.ts. A page that builds its rows with `el` cannot
// have an injection bug through an object's name or an operator's error
// message, which is the one place cluster data is genuinely hostile.

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/** An element, with attributes and children. Strings become text nodes. */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Attrs = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value === undefined || value === false) continue;
        if (name === 'class') node.className = String(value);
        else if (name === 'text') node.textContent = String(value);
        else node.setAttribute(name, String(value));
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child);
    }
    return node;
}

/** A <button> with a click handler. */
export function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
    const node = el('button', { type: 'button', ...attrs }, label);
    node.addEventListener('click', onClick);
    return node;
}

/** Replaces everything in a node. */
export function replace(parent: Element, ...children: Child[]): void {
    parent.replaceChildren();
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        parent.append(child);
    }
}

/** The element with an id, or a thrown error -- a missing id is our bug, not the user's. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the page has no #${id}`);
    return node as T;
}

/**
 * An inline SVG icon. The only innerHTML in the plugin, and it is only ever
 * given the constants in parts.ts -- never anything from the cluster.
 */
export function svg(markup: string, className = 'icon'): SVGElement {
    const holder = document.createElement('span');
    holder.innerHTML = markup;
    const node = holder.firstElementChild as SVGElement;
    node.setAttribute('class', className);
    return node;
}

/** A coloured dot for a tone. */
export function dot(tone: string): HTMLElement {
    return el('span', { class: `dot dot-${tone || 'none'}`, 'aria-hidden': 'true' });
}
