// `k8sdockside.ui`, which the app's bridge has from 0.1.36 on (this plugin's
// minAppVersion) but the @k8sdockside/plugin-sdk copy in node_modules does
// not declare yet. Merged into the SDK's own namespace, copied from the app's
// k8sdockside.d.ts.

declare namespace K8sDockside {
    interface SectionOptions {
        /** What the fold is remembered by. Defaults to the title; give one when the title changes. */
        id?: string;
        /** The heading, written in sentence case; it is shown in capitals. */
        title: string;
        /** A number or a few words after the title: how many rows, of how many. */
        count?: number | string;
        /** Whose it is, after the count: "· Talos". */
        by?: string;
        /** What it is, for the fold button's tooltip: "the disks". Defaults to "this section". */
        what?: string;
        /** False to start folded until the user opens it. Defaults to open. */
        open?: boolean;
        /** Drawn in a bordered box, as a summary block, rather than straight onto the page. */
        boxed?: boolean;
        /** Where to append it. Left out, it is the page's to place: `parent.append(section.root)`. */
        parent?: Element;
    }

    /** A block of the page with a heading that folds it away, as the details panel's own sections do. */
    interface Section {
        /** The whole block, heading and all. */
        root: HTMLElement;
        /** Where its contents go. Hidden, not emptied, while it is folded. */
        body: HTMLElement;
        /** Buttons on the heading's row, shown while it is open. */
        actions: HTMLElement;
        setTitle(title: string): void;
        setCount(count: number | string | undefined): void;
        isFolded(): boolean;
        /** Folds or opens it, as a click would, remembering it. */
        setFolded(folded: boolean): void;
        /** Called with true when it folds and false when it opens. Returns a function that stops listening. */
        onToggle(fn: (folded: boolean) => void): () => void;
    }

    interface UI {
        /**
         * A section with a heading that folds it away. The same heading,
         * chevron and spacing as the app's own sections, and folds kept in
         * the same place: the app's settings, for every object on every
         * cluster.
         */
        section(options: SectionOptions): Section;
    }

    interface Bridge {
        /** Pieces drawn the way the app draws its own. From 0.1.36. */
        ui?: UI;
    }
}
