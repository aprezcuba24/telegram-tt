import {
  hasElementChanged,
  isComponentElement,
  isEmptyElement,
  isRealElement,
  isTextElement,
  mountComponent,
  renderComponent,
  unmountTree,
  getTarget,
  setTarget,
  VirtualElement,
  VirtualElementComponent,
  VirtualRealElement,
} from './teact';
import generateIdFor from '../../util/generateIdFor';
import { DEBUG } from '../../config';
import { addEventListener, removeEventListener } from './dom-events';

type VirtualDomHead = {
  children: [VirtualElement] | [];
};

const FILTERED_ATTRIBUTES = new Set(['key', 'ref', 'teactFastList', 'teactOrderKey']);
const HTML_ATTRIBUTES = new Set(['dir']);
const MAPPED_ATTRIBUTES: { [k: string]: string } = {
  autoPlay: 'autoplay',
  autoComplete: 'autocomplete',
};
const INDEX_KEY_PREFIX = '__indexKey#';

const headsByElement: Record<string, VirtualDomHead> = {};
// eslint-disable-next-line @typescript-eslint/naming-convention
let DEBUG_virtualTreeSize = 1;

function render($element?: VirtualElement, parentEl?: HTMLElement | null) {
  if (!parentEl) {
    return undefined;
  }

  let headId = parentEl.getAttribute('data-teact-head-id');
  if (!headId) {
    headId = generateIdFor(headsByElement);
    headsByElement[headId] = { children: [] };
    parentEl.setAttribute('data-teact-head-id', headId);
  }

  const $head = headsByElement[headId];
  $head.children = [renderWithVirtual(parentEl, $head.children[0], $element, $head, 0) as VirtualElement];

  if (process.env.APP_ENV === 'perf') {
    DEBUG_virtualTreeSize = 0;
    DEBUG_addToVirtualTreeSize($head);

    return DEBUG_virtualTreeSize;
  }

  return undefined;
}

function renderWithVirtual(
  parentEl: HTMLElement,
  $current: VirtualElement | undefined,
  $new: VirtualElement | undefined,
  $parent: VirtualRealElement | VirtualDomHead,
  index: number,
  {
    skipComponentUpdate = false,
    forceIndex = false,
    fragment,
    moveDirection,
  }: {
    skipComponentUpdate?: boolean;
    forceIndex?: boolean;
    fragment?: DocumentFragment;
    moveDirection?: 'up' | 'down';
  } = {},
) {
  if (
    !skipComponentUpdate
    && $current && $new
    && isComponentElement($current) && isComponentElement($new)
    && !hasElementChanged($current, $new)
  ) {
    $new = updateComponent($current, $new);
  }

  // Parent element may have changed, so we need to update the listener closure.
  if (!skipComponentUpdate && $new && isComponentElement($new) && $new.componentInstance.isMounted) {
    setupComponentUpdateListener($new, $parent, index, parentEl);
  }

  if ($current === $new) {
    return $new;
  }

  if (!$current && $new) {
    if (isComponentElement($new)) {
      $new = initComponent($new, $parent, index, parentEl);
    }

    const node = createNode($new);
    setTarget($new, node);

    if (forceIndex && parentEl.childNodes[index]) {
      parentEl.insertBefore(node, parentEl.childNodes[index]);
    } else {
      (fragment || parentEl).appendChild(node);
    }
  } else if ($current && !$new) {
    parentEl.removeChild(getTarget($current)!);
    unmountTree($current);
  } else if ($current && $new) {
    if (hasElementChanged($current, $new)) {
      if (isComponentElement($new)) {
        $new = initComponent($new, $parent, index, parentEl);
      }

      const node = createNode($new);
      setTarget($new, node);
      parentEl.replaceChild(node, getTarget($current)!);
      unmountTree($current);
    } else {
      const areComponents = isComponentElement($current) && isComponentElement($new);

      if (!areComponents) {
        setTarget($new, getTarget($current)!);
      }

      if (isRealElement($current) && isRealElement($new)) {
        if (moveDirection) {
          const node = getTarget($current)!;
          const nextSibling = parentEl.childNodes[moveDirection === 'up' ? index : index + 1];

          if (nextSibling) {
            parentEl.insertBefore(node, nextSibling);
          } else {
            (fragment || parentEl).appendChild(node);
          }
        }

        if (!areComponents) {
          updateAttributes($current, $new, getTarget($current) as HTMLElement);
        }

        $new.children = renderChildren(
          $current,
          $new,
          areComponents ? parentEl : getTarget($current) as HTMLElement,
        );
      }
    }
  }

  return $new;
}

function initComponent(
  $element: VirtualElementComponent, $parent: VirtualRealElement | VirtualDomHead, index: number, parentEl: HTMLElement,
) {
  if (!isComponentElement($element)) {
    return $element;
  }

  const { componentInstance } = $element;

  if (!componentInstance.isMounted) {
    $element = mountComponent(componentInstance);
    setupComponentUpdateListener($element, $parent, index, parentEl);

    const $firstChild = $element.children[0];
    if (isComponentElement($firstChild)) {
      $element.children = [initComponent($firstChild, $element, 0, parentEl)];
    }

    componentInstance.isMounted = true;
  }

  return $element;
}

function updateComponent($current: VirtualElementComponent, $new: VirtualElementComponent) {
  $current.componentInstance.props = $new.componentInstance.props;

  return renderComponent($current.componentInstance);
}

function setupComponentUpdateListener(
  $element: VirtualElementComponent, $parent: VirtualRealElement | VirtualDomHead, index: number, parentEl: HTMLElement,
) {
  const { componentInstance } = $element;

  componentInstance.onUpdate = () => {
    $parent.children[index] = renderWithVirtual(
      parentEl,
      $parent.children[index],
      componentInstance.$element,
      $parent,
      index,
      { skipComponentUpdate: true },
    ) as VirtualElementComponent;
  };
}

function createNode($element: VirtualElement): Node {
  if (isEmptyElement($element)) {
    return document.createTextNode('');
  }

  if (isTextElement($element)) {
    return document.createTextNode($element.value);
  }

  if (isComponentElement($element)) {
    return createNode($element.children[0] as VirtualElement);
  }

  const { tag, props, children = [] } = $element;
  const element = document.createElement(tag);

  if (typeof props.ref === 'object') {
    props.ref.current = element;
  }

  Object.keys(props).forEach((key) => {
    addAttribute(element, key, props[key]);
  });

  $element.children = children.map(($child, i) => (
    renderWithVirtual(element, undefined, $child, $element, i) as VirtualElement
  ));

  return element;
}

function renderChildren(
  $current: VirtualRealElement, $new: VirtualRealElement, currentEl: HTMLElement,
) {
  if ($new.props.teactFastList) {
    return renderFastListChildren($current, $new, currentEl);
  }

  const maxLength = Math.max($current.children.length, $new.children.length);
  const newChildren = [];
  const fragment = $new.children.length > $current.children.length + 1 ? document.createDocumentFragment() : undefined;

  for (let i = 0; i < maxLength; i++) {
    const $newChild = renderWithVirtual(
      currentEl,
      $current.children[i],
      $new.children[i],
      $new,
      i,
      i >= $current.children.length ? { fragment } : undefined,
    );

    if ($newChild) {
      newChildren.push($newChild);
    }
  }

  if (fragment) {
    currentEl.appendChild(fragment);
  }

  return newChildren;
}

function renderFastListChildren($current: VirtualRealElement, $new: VirtualRealElement, currentEl: HTMLElement) {
  const newKeys = new Set(
    $new.children.map(($newChild) => {
      const key = 'props' in $newChild && $newChild.props.key;

      if (DEBUG && isRealElement($newChild) && !key) {
        // eslint-disable-next-line no-console
        console.warn('Missing `key` in `teactFastList`');
      }

      return key;
    }),
  );

  let currentRemainingIndex = 0;
  const remainingByKey = $current.children
    .reduce((acc, $currentChild, i) => {
      let key = 'props' in $currentChild ? $currentChild.props.key : undefined;

      // First we handle removed children
      if (key && !newKeys.has(key)) {
        renderWithVirtual(currentEl, $currentChild, undefined, $new, -1);

        return acc;
      } else if (!key) {
        const $newChild = $new.children[i];
        const newChildKey = ($newChild && 'props' in $newChild) ? $newChild.props.key : undefined;
        // If a non-key element remains at the same index we preserve it with a virtual `key`
        if ($newChild && !newChildKey) {
          key = `${INDEX_KEY_PREFIX}${i}`;
        } else {
          renderWithVirtual(currentEl, $currentChild, undefined, $new, -1);

          return acc;
        }
      }

      // Then we build up info about remaining children
      acc[key] = {
        $element: $currentChild,
        index: currentRemainingIndex++,
        order: 'props' in $currentChild ? $currentChild.props.teactOrderKey : undefined,
      };
      return acc;
    }, {} as Record<string, { $element: VirtualElement; index: number; order?: number }>);

  let newChildren: VirtualElement[] = [];

  let fragmentQueue: VirtualElement[] | undefined;
  let fragmentIndex: number | undefined;

  let currentPreservedIndex = 0;

  $new.children.forEach(($newChild, i) => {
    const key = 'props' in $newChild ? $newChild.props.key : `${INDEX_KEY_PREFIX}${i}`;
    const currentChildInfo = remainingByKey[key];

    if (!currentChildInfo) {
      // All new nodes are queued to be inserted with fragments if possible.
      if (!fragmentQueue) {
        fragmentQueue = [];
        fragmentIndex = i;
      }

      fragmentQueue.push($newChild);
      return;
    }

    if (fragmentQueue) {
      newChildren = newChildren.concat(flushFragmentQueue(fragmentQueue, fragmentIndex!, currentEl, $new));
      fragmentIndex = undefined;
      fragmentQueue = undefined;
    }

    // This is a "magic" `teactOrderKey` property that tells us the element is updated
    const order = 'props' in $newChild ? $newChild.props.teactOrderKey : undefined;
    const shouldMoveNode = currentChildInfo.index !== currentPreservedIndex && currentChildInfo.order !== order;
    const isMovingDown = shouldMoveNode && currentPreservedIndex > currentChildInfo.index;

    // When the node goes down, preserved indexing actually breaks, so the "magic" should help.
    if (!shouldMoveNode || isMovingDown) {
      currentPreservedIndex++;
    }

    newChildren.push(
      renderWithVirtual(currentEl, currentChildInfo.$element, $newChild, $new, i, {
        forceIndex: true,
        ...(shouldMoveNode && {
          moveDirection: isMovingDown ? 'down' : 'up',
        }),
      })!,
    );
  });

  if (fragmentQueue) {
    newChildren = newChildren.concat(flushFragmentQueue(fragmentQueue, fragmentIndex!, currentEl, $new));
  }

  return newChildren;
}

function flushFragmentQueue(
  fragmentQueue: VirtualElement[], fragmentIndex: number, parentEl: HTMLElement, $parent: VirtualRealElement,
) {
  if (fragmentQueue.length === 1) {
    return [renderWithVirtual(parentEl, undefined, fragmentQueue[0], $parent, fragmentIndex, { forceIndex: true })!];
  } else if (fragmentQueue.length > 1) {
    const fragment = document.createDocumentFragment();
    const newChildren = fragmentQueue.map(($fragmentChild) => (
      renderWithVirtual(parentEl, undefined, $fragmentChild, $parent, fragmentIndex!, { fragment })!
    ));

    if (parentEl.childNodes[fragmentIndex]) {
      parentEl.insertBefore(fragment, parentEl.childNodes[fragmentIndex]);
    } else {
      parentEl.appendChild(fragment);
    }

    return newChildren;
  }

  throw new Error('Unexpected input');
}

function updateAttributes($current: VirtualRealElement, $new: VirtualRealElement, element: HTMLElement) {
  const currentKeys = Object.keys($current.props);
  const newKeys = Object.keys($new.props);

  currentKeys.forEach((key) => {
    if ($current.props[key] !== undefined && $new.props[key] === undefined) {
      removeAttribute(element, key, $current.props[key]);
    }
  });

  newKeys.forEach((key) => {
    if ($new.props[key] === undefined) {
      return;
    }

    if ($current.props[key] !== $new.props[key]) {
      if ($current.props[key] === undefined) {
        addAttribute(element, key, $new.props[key]);
      } else {
        updateAttribute(element, key, $current.props[key], $new.props[key]);
      }
    }
  });
}

function addAttribute(element: HTMLElement, key: string, value: any) {
  if (value === undefined) {
    return;
  }

  // An optimization attempt
  if (key === 'className') {
    element.className = value;
    // An optimization attempt
  } else if (key === 'value') {
    (element as HTMLInputElement).value = value;
  } else if (key === 'style') {
    element.style.cssText = value;
  } else if (key.startsWith('on')) {
    addEventListener(element, key, value, key.endsWith('Capture'));
  } else if (key.startsWith('data-') || HTML_ATTRIBUTES.has(key)) {
    element.setAttribute(key, value);
  } else if (!FILTERED_ATTRIBUTES.has(key)) {
    (element as any)[MAPPED_ATTRIBUTES[key] || key] = value;
  }
}

function removeAttribute(element: HTMLElement, key: string, value: any) {
  if (key === 'className') {
    element.className = '';
  } else if (key === 'value') {
    (element as HTMLInputElement).value = '';
  } else if (key === 'style') {
    element.style.cssText = '';
  } else if (key.startsWith('on')) {
    removeEventListener(element, key, value, key.endsWith('Capture'));
  } else if (key.startsWith('data-') || HTML_ATTRIBUTES.has(key)) {
    element.removeAttribute(key);
  } else if (!FILTERED_ATTRIBUTES.has(key)) {
    delete (element as any)[MAPPED_ATTRIBUTES[key] || key];
  }
}

function updateAttribute(element: HTMLElement, key: string, oldValue: any, newValue: any) {
  if (key === 'value') {
    // Removing and adding value causes a cursor jump
    (element as HTMLInputElement).value = newValue !== undefined ? newValue : '';
  } else {
    removeAttribute(element, key, oldValue);
    addAttribute(element, key, newValue);
  }
}

// eslint-disable-next-line @typescript-eslint/naming-convention
function DEBUG_addToVirtualTreeSize($current: VirtualRealElement | VirtualDomHead) {
  DEBUG_virtualTreeSize += $current.children.length;

  $current.children.forEach(($child) => {
    if (isRealElement($child)) {
      DEBUG_addToVirtualTreeSize($child);
    }
  });
}

export default { render };
