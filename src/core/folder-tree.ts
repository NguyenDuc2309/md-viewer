import className from '@/config/class-name'

/* Shared tree model + rendering used by both folder managers */

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileTreeNode[]
  expanded?: boolean
  /** lazy directories: children not fetched yet */
  loaded?: boolean
  loading?: boolean
  /** path mode: file:// url of this entry */
  url?: string
  /** handle mode */
  fileObj?: File
  fileHandle?: any
}

export const MD_EXTENSIONS = ['.md', '.markdown', '.mkd', '.mdx']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target'])

export function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase()
  return MD_EXTENSIONS.some(ext => lower.endsWith(ext))
}

export function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name)
}

export function sortNodes(nodes: FileTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.isDirectory === b.isDirectory) {
      return a.name.localeCompare(b.name, undefined, { numeric: true })
    }
    return a.isDirectory ? -1 : 1
  })
}

export function sortTree(node: FileTreeNode) {
  if (!node.children) return
  sortNodes(node.children)
  node.children.forEach(sortTree)
}

export function filterNode(
  node: FileTreeNode,
  query: string,
): FileTreeNode | null {
  if (!query) return node

  const lowerQuery = query.toLowerCase()
  if (!node.isDirectory) {
    return node.name.toLowerCase().includes(lowerQuery) ? node : null
  }

  const filteredChildren: FileTreeNode[] = []
  if (node.children) {
    for (const child of node.children) {
      const filtered = filterNode(child, query)
      if (filtered) filteredChildren.push(filtered)
    }
  }

  if (
    filteredChildren.length > 0 ||
    node.name.toLowerCase().includes(lowerQuery)
  ) {
    return { ...node, children: filteredChildren, expanded: true }
  }
  return null
}

export const icons = {
  folder: (size: number, strokeWidth = 2) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  file: (size: number) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
  clock: (size: number) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  close: (size: number) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  change: (size: number) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`,
  up: (size: number) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`,
  chevron: (size: number) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
}

export interface RenderTreeOptions {
  activePath: string | null
  onToggleDir: (node: FileTreeNode) => void
  onSelectFile: (node: FileTreeNode) => void
  loadingText: string
}

export function renderNodeChildren(
  nodes: FileTreeNode[],
  parentElement: HTMLElement,
  level: number,
  opts: RenderTreeOptions,
) {
  for (const node of nodes) {
    const li = document.createElement('li')
    li.className = `${className.FOLDER_ITEM} ${
      node.isDirectory ? className.FOLDER_ITEM_DIR : className.FOLDER_ITEM_FILE
    }`
    if (!node.isDirectory && node.path === opts.activePath) {
      li.classList.add(className.FOLDER_ITEM_ACTIVE)
    }

    const itemContent = document.createElement('div')
    itemContent.className = 'md-reader__folder-item-content'
    itemContent.style.paddingLeft = `${level * 14 + 12}px`
    itemContent.title = node.path

    const label = document.createElement('span')
    label.className = 'md-reader__folder-label'
    label.textContent = node.name

    if (node.isDirectory) {
      const toggleIcon = document.createElement('span')
      toggleIcon.className = `md-reader__folder-toggle-icon ${
        node.expanded ? 'expanded' : 'collapsed'
      }`
      toggleIcon.innerHTML = icons.chevron(11)

      const folderIcon = document.createElement('span')
      folderIcon.className = 'md-reader__folder-node-icon'
      folderIcon.innerHTML = icons.folder(14)

      itemContent.appendChild(toggleIcon)
      itemContent.appendChild(folderIcon)
      itemContent.appendChild(label)
      itemContent.onclick = () => opts.onToggleDir(node)
      li.appendChild(itemContent)

      if (node.expanded) {
        const subUl = document.createElement('ul')
        subUl.className = 'md-reader__folder-sub-tree'
        if (node.loading) {
          const loading = document.createElement('li')
          loading.className = 'md-reader__folder-sub-loading'
          loading.style.paddingLeft = `${(level + 1) * 14 + 12}px`
          loading.textContent = opts.loadingText
          subUl.appendChild(loading)
        } else if (node.children && node.children.length > 0) {
          renderNodeChildren(node.children, subUl, level + 1, opts)
        }
        if (subUl.childElementCount) li.appendChild(subUl)
      }
    } else {
      const fileIcon = document.createElement('span')
      fileIcon.className = 'md-reader__folder-node-icon'
      fileIcon.innerHTML = icons.file(13)

      itemContent.appendChild(fileIcon)
      itemContent.appendChild(label)
      itemContent.onclick = () => opts.onSelectFile(node)
      li.appendChild(itemContent)
    }

    parentElement.appendChild(li)
  }
}

/** Highlight the active file and scroll it into view inside the tree */
export function revealActive(treeList: HTMLElement) {
  const active = treeList.querySelector(`.${className.FOLDER_ITEM_ACTIVE}`)
  if (active && active.scrollIntoView) {
    active.scrollIntoView({ block: 'nearest' })
  }
}
