import className from '@/config/class-name'
import i18n from '@/config/i18n'

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileTreeNode[]
  fileObj?: File
  expanded?: boolean
}

const MD_EXTENSIONS = ['.md', '.markdown', '.mkd', '.mdx']

function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase()
  return MD_EXTENSIONS.some(ext => lower.endsWith(ext))
}

export class FolderManager {
  private rootNode: FileTreeNode | null = null
  private activePath: string | null = null
  private searchQuery: string = ''
  private onFileSelected: (content: string, name: string, path: string) => void
  private localize: (key: string) => string = i18n()
  private container: HTMLElement
  private fileInput: HTMLInputElement

  constructor(
    container: HTMLElement,
    onFileSelected: (content: string, name: string, path: string) => void,
    language?: string,
  ) {
    this.container = container
    this.onFileSelected = onFileSelected
    this.localize = i18n(language)

    // Synchronous native input for reliable user gesture preservation on all pages (including file://)
    this.fileInput = document.createElement('input')
    this.fileInput.type = 'file'
    // @ts-ignore
    this.fileInput.webkitdirectory = true
    // @ts-ignore
    this.fileInput.directory = true
    this.fileInput.multiple = true
    this.fileInput.style.display = 'none'

    this.fileInput.addEventListener('change', async () => {
      if (this.fileInput.files && this.fileInput.files.length > 0) {
        this.rootNode = this.buildTreeFromFileList(this.fileInput.files)
        this.searchQuery = ''
        this.render()
      }
    })

    document.body.appendChild(this.fileInput)
    this.render()
  }

  public setLanguage(language?: string) {
    this.localize = i18n(language)
    this.render()
  }

  public pickFolder() {
    this.fileInput.value = ''
    this.fileInput.click()
  }

  private buildTreeFromFileList(files: FileList): FileTreeNode {
    let rootName = 'Folder'
    if (files.length > 0 && files[0].webkitRelativePath) {
      rootName = files[0].webkitRelativePath.split('/')[0]
    }

    const root: FileTreeNode = {
      name: rootName,
      path: rootName,
      isDirectory: true,
      children: [],
      expanded: true,
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (!isMarkdownFile(file.name)) continue

      const relativePath = file.webkitRelativePath || file.name
      const parts = relativePath.split('/')

      // Skip hidden folders and node_modules
      if (parts.some(p => p.startsWith('.') || p === 'node_modules')) {
        continue
      }

      if (parts.length === 1) {
        root.children.push({
          name: file.name,
          path: file.name,
          isDirectory: false,
          fileObj: file,
        })
        continue
      }

      let currentNode = root
      let currentPath = parts[0]

      for (let j = 1; j < parts.length; j++) {
        const part = parts[j]
        currentPath += `/${part}`
        const isFile = j === parts.length - 1

        if (isFile) {
          currentNode.children = currentNode.children || []
          currentNode.children.push({
            name: part,
            path: currentPath,
            isDirectory: false,
            fileObj: file,
          })
        } else {
          currentNode.children = currentNode.children || []
          let nextNode = currentNode.children.find(
            c => c.isDirectory && c.name === part,
          )
          if (!nextNode) {
            nextNode = {
              name: part,
              path: currentPath,
              isDirectory: true,
              children: [],
              expanded: true,
            }
            currentNode.children.push(nextNode)
          }
          currentNode = nextNode
        }
      }
    }

    const sortNode = (node: FileTreeNode) => {
      if (node.children) {
        node.children.sort((a, b) => {
          if (a.isDirectory === b.isDirectory) {
            return a.name.localeCompare(b.name, undefined, { numeric: true })
          }
          return a.isDirectory ? -1 : 1
        })
        node.children.forEach(sortNode)
      }
    }
    sortNode(root)

    return root
  }

  public async selectFile(node: FileTreeNode) {
    if (node.isDirectory) {
      node.expanded = !node.expanded
      this.render()
      return
    }

    try {
      let content = ''
      if (node.fileObj) {
        content = await node.fileObj.text()
      }

      this.activePath = node.path
      this.onFileSelected(content, node.name, node.path)
      this.render()
    } catch (err) {
      console.error('Error reading markdown file:', err)
    }
  }

  public closeFolder() {
    this.rootNode = null
    this.activePath = null
    this.searchQuery = ''
    this.fileInput.value = ''
    this.render()
  }

  private filterNode(node: FileTreeNode, query: string): FileTreeNode | null {
    if (!query) return node

    const lowerQuery = query.toLowerCase()
    if (!node.isDirectory) {
      return node.name.toLowerCase().includes(lowerQuery) ? node : null
    }

    const filteredChildren: FileTreeNode[] = []
    if (node.children) {
      for (const child of node.children) {
        const filtered = this.filterNode(child, query)
        if (filtered) {
          filteredChildren.push(filtered)
        }
      }
    }

    if (
      filteredChildren.length > 0 ||
      node.name.toLowerCase().includes(lowerQuery)
    ) {
      return {
        ...node,
        children: filteredChildren,
        expanded: true,
      }
    }

    return null
  }

  public render() {
    this.container.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = className.FOLDER_WRAP

    if (
      !this.rootNode ||
      !this.rootNode.children ||
      this.rootNode.children.length === 0
    ) {
      // Empty state
      const emptyDiv = document.createElement('div')
      emptyDiv.className = className.FOLDER_EMPTY

      const icon = document.createElement('div')
      icon.className = 'md-reader__folder-empty-icon'
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>`

      const title = document.createElement('div')
      title.className = 'md-reader__folder-empty-title'
      title.textContent = this.localize('no_folder_selected')

      const desc = document.createElement('div')
      desc.className = 'md-reader__folder-empty-desc'
      desc.textContent = this.localize('folder_desc')

      const openBtn = document.createElement('button')
      openBtn.className = 'md-reader__folder-open-btn'
      openBtn.type = 'button'
      openBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg> <span>${this.localize('btn_open_folder')}</span>`
      openBtn.onclick = e => {
        e.preventDefault()
        e.stopPropagation()
        this.pickFolder()
      }

      emptyDiv.appendChild(icon)
      emptyDiv.appendChild(title)
      emptyDiv.appendChild(desc)
      emptyDiv.appendChild(openBtn)
      wrap.appendChild(emptyDiv)
      this.container.appendChild(wrap)
      return
    }

    // Header Bar
    const header = document.createElement('div')
    header.className = className.FOLDER_HEADER

    const rootInfo = document.createElement('div')
    rootInfo.className = 'md-reader__folder-root-info'
    rootInfo.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
    </svg><span class="md-reader__folder-root-name" title="${this.rootNode.name}">${this.rootNode.name}</span>`

    const actions = document.createElement('div')
    actions.className = 'md-reader__folder-actions'

    const changeBtn = document.createElement('button')
    changeBtn.className = 'md-reader__folder-action-btn'
    changeBtn.type = 'button'
    changeBtn.title = this.localize('btn_change_folder')
    changeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`
    changeBtn.onclick = e => {
      e.preventDefault()
      e.stopPropagation()
      this.pickFolder()
    }

    const closeBtn = document.createElement('button')
    closeBtn.className = 'md-reader__folder-action-btn'
    closeBtn.type = 'button'
    closeBtn.title = this.localize('btn_close_folder')
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
    closeBtn.onclick = e => {
      e.preventDefault()
      e.stopPropagation()
      this.closeFolder()
    }

    actions.appendChild(changeBtn)
    actions.appendChild(closeBtn)
    header.appendChild(rootInfo)
    header.appendChild(actions)
    wrap.appendChild(header)

    // Search Input
    const searchWrap = document.createElement('div')
    searchWrap.className = className.FOLDER_SEARCH
    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.placeholder = this.localize('placeholder_search')
    searchInput.value = this.searchQuery
    searchInput.oninput = (e: any) => {
      this.searchQuery = e.target.value
      this.renderTree(treeList)
    }
    searchWrap.appendChild(searchInput)
    wrap.appendChild(searchWrap)

    // Tree List
    const treeList = document.createElement('ul')
    treeList.className = className.FOLDER_TREE
    this.renderTree(treeList)

    wrap.appendChild(treeList)
    this.container.appendChild(wrap)
  }

  private renderTree(treeList: HTMLElement) {
    treeList.innerHTML = ''
    if (!this.rootNode) return

    const filtered = this.filterNode(this.rootNode, this.searchQuery)
    if (!filtered || !filtered.children || filtered.children.length === 0) {
      const noMatch = document.createElement('div')
      noMatch.className = 'md-reader__folder-no-match'
      noMatch.textContent = this.localize('no_files_found')
      treeList.appendChild(noMatch)
      return
    }

    this.renderNodeChildren(filtered.children, treeList, 0)
  }

  private renderNodeChildren(
    nodes: FileTreeNode[],
    parentElement: HTMLElement,
    level: number,
  ) {
    for (const node of nodes) {
      const li = document.createElement('li')
      li.className = `${className.FOLDER_ITEM} ${
        node.isDirectory
          ? className.FOLDER_ITEM_DIR
          : className.FOLDER_ITEM_FILE
      }`
      if (!node.isDirectory && node.path === this.activePath) {
        li.classList.add(className.FOLDER_ITEM_ACTIVE)
      }

      const itemContent = document.createElement('div')
      itemContent.className = 'md-reader__folder-item-content'
      itemContent.style.paddingLeft = `${level * 14 + 12}px`
      itemContent.title = node.path

      if (node.isDirectory) {
        const toggleIcon = document.createElement('span')
        toggleIcon.className = `md-reader__folder-toggle-icon ${
          node.expanded ? 'expanded' : 'collapsed'
        }`
        toggleIcon.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>`

        const folderIcon = document.createElement('span')
        folderIcon.className = 'md-reader__folder-node-icon'
        folderIcon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`

        const label = document.createElement('span')
        label.className = 'md-reader__folder-label'
        label.textContent = node.name

        itemContent.appendChild(toggleIcon)
        itemContent.appendChild(folderIcon)
        itemContent.appendChild(label)

        itemContent.onclick = () => {
          node.expanded = !node.expanded
          this.render()
        }

        li.appendChild(itemContent)

        if (node.expanded && node.children && node.children.length > 0) {
          const subUl = document.createElement('ul')
          subUl.className = 'md-reader__folder-sub-tree'
          this.renderNodeChildren(node.children, subUl, level + 1)
          li.appendChild(subUl)
        }
      } else {
        const fileIcon = document.createElement('span')
        fileIcon.className = 'md-reader__folder-node-icon'
        fileIcon.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`

        const label = document.createElement('span')
        label.className = 'md-reader__folder-label'
        label.textContent = node.name

        itemContent.appendChild(fileIcon)
        itemContent.appendChild(label)

        itemContent.onclick = () => {
          this.selectFile(node)
        }

        li.appendChild(itemContent)
      }

      parentElement.appendChild(li)
    }
  }
}
