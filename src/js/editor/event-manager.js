import assert from 'mobiledoc-kit/utils/assert';
import {
  parsePostFromPaste,
  setClipboardData,
  parsePostFromDrop
} from 'mobiledoc-kit/utils/parse-utils';
import { filter, forEach } from 'mobiledoc-kit/utils/array-utils';
import Key from 'mobiledoc-kit/utils/key';
import TextInputHandler from 'mobiledoc-kit/editor/text-input-handler';
import SelectionManager from 'mobiledoc-kit/editor/selection-manager';
import Browser from 'mobiledoc-kit/utils/browser';

const ELEMENT_EVENT_TYPES = [
  'keydown', 'keyup', 'cut', 'copy', 'paste', 'keypress', 'drop'
];

export default class EventManager {
  constructor(editor) {
    this.editor = editor;
    this.logger = editor.loggerFor('event-manager');
    this._textInputHandler = new TextInputHandler(editor);
    this._listeners = [];
    this.modifierKeys = {
      shift: false,
      alt:   false,
      ctrl:  false
    };

    this._selectionManager = new SelectionManager(
      this.editor, this.selectionDidChange.bind(this));
  }

  init() {
    let { editor: { element } } = this;
    assert(`Cannot init EventManager without element`, !!element);

    ELEMENT_EVENT_TYPES.forEach(type => {
      this._addListener(element, type);
    });

    this._selectionManager.start();
  }

  registerInputHandler(inputHandler) {
    this._textInputHandler.register(inputHandler);
  }

  _addListener(context, type) {
    assert(`Missing listener for ${type}`, !!this[type]);

    let listener = (event) => this._handleEvent(type, event);
    context.addEventListener(type, listener);
    this._listeners.push([context, type, listener]);
  }

  _removeListeners() {
    this._listeners.forEach(([context, type, listener]) => {
      context.removeEventListener(type, listener);
    });
    this._listeners = [];
  }

  // This is primarily useful for programmatically simulating events on the
  // editor from the tests.
  _trigger(context, type, event) {
    forEach(
      filter(this._listeners, ([_context, _type]) => {
        return _context === context && _type === type;
      }),
      ([context, type, listener]) => {
        listener.call(context, event);
      }
    );
  }

  destroy() {
    this._textInputHandler.destroy();
    this._selectionManager.destroy();
    this._removeListeners();
  }

  _handleEvent(type, event) {
    let {target: element} = event;
    if (!this.isElementAddressable(element)) {
      // abort handling this event
      return true;
    }

    this[type](event);
  }

  isElementAddressable(element) {
    return this.editor.cursor.isAddressable(element);
  }

  selectionDidChange(selection /*, prevSelection */) {
    let shouldNotify = true;
    let { anchorNode } = selection;
    if (!this.isElementAddressable(anchorNode)) {
      if (!this.editor.range.isBlank) {
        // Selection changed from something addressable to something
        // not-addressable -- e.g., blur event, user clicked outside editor,
        // etc
        shouldNotify = true;
      } else {
        // selection changes wholly outside the editor should not trigger
        // change notifications
        shouldNotify = false;
      }
    }

    if (shouldNotify) {
      this.editor._readRangeFromDOM();
    }
  }

  keypress(event) {
    let { editor, _textInputHandler } = this;
    if (!editor.hasCursor()) { return; }

    let key = Key.fromEvent(event);
    if (!key.isPrintable()) {
      return;
    } else {
      event.preventDefault();
    }

    _textInputHandler.handle(key.toString());
  }

  keydown(event) {
    let { editor } = this;
    if (!editor.hasCursor()) { return; }
    if (!editor.isEditable) { return; }

    let key = Key.fromEvent(event);
    this._updateModifiersFromKey(key, {isDown:true});

    if (editor.handleKeyCommand(event)) { return; }

    if (editor.post.isBlank) {
      editor._insertEmptyMarkupSectionAtCursor();
    }

    let range = editor.range;

    switch(true) {
      // FIXME This should be restricted to only card/atom boundaries
      case key.isHorizontalArrowWithoutModifiersOtherThanShift():
        let newRange;
        if (key.isShift()) {
          newRange = range.extend(key.direction * 1);
        } else {
          newRange = range.move(key.direction);
        }

        editor.selectRange(newRange);
        event.preventDefault();
        break;
      case key.isDelete():
        let { direction } = key;
        let unit = 'char';
        if (this.modifierKeys.alt && Browser.isMac()) {
          unit = 'word';
        } else if (this.modifierKeys.ctrl && Browser.isWin()) {
          unit = 'word';
        }
        editor.performDelete({direction, unit});
        event.preventDefault();
        break;
      case key.isEnter():
        editor.handleNewline(event);
        break;
      case key.isTab():
        // Handle tab here because it does not fire a `keypress` event
        event.preventDefault();
        this._textInputHandler.handle(key.toString());
        break;
    }
  }

  keyup(event) {
    let { editor } = this;
    if (!editor.hasCursor()) { return; }
    let key = Key.fromEvent(event);
    this._updateModifiersFromKey(key, {isDown:false});
  }

  cut(event) {
    event.preventDefault();

    this.copy(event);
    this.editor.performDelete();
  }

  copy(event) {
    event.preventDefault();

    let { editor, editor: { range, post } } = this;
    post = post.trimTo(range);

    let data = {
      html: editor.serializePost(post, 'html'),
      text: editor.serializePost(post, 'text'),
      mobiledoc: editor.serializePost(post, 'mobiledoc')
    };

    setClipboardData(event, data, window);
  }

  paste(event) {
    event.preventDefault();

    let { editor } = this;
    let range = editor.range;

    if (!range.isCollapsed) {
      editor.performDelete();
    }
    let position = editor.range.head;
    let targetFormat = this.modifierKeys.shift ? 'text' : 'html';
    let pastedPost = parsePostFromPaste(event, editor, {targetFormat});

    editor.run(postEditor => {
      let nextPosition = postEditor.insertPost(position, pastedPost);
      postEditor.setRange(nextPosition);
    });
  }

  drop(event) {
    event.preventDefault();

    let { clientX: x, clientY: y } = event;
    let { editor } = this;

    let position = editor.positionAtPoint(x, y);
    if (!position) {
      this.logger.log('Could not find drop position');
      return;
    }

    let post = parsePostFromDrop(event, editor, {logger: this.logger});
    if (!post) {
      this.logger.log('Could not determine post from drop event');
      return;
    }

    editor.run(postEditor => {
      let nextPosition = postEditor.insertPost(position, post);
      postEditor.setRange(nextPosition);
    });
  }

  _updateModifiersFromKey(key, {isDown}) {
    if (key.isShiftKey()) {
      this.modifierKeys.shift = isDown;
    } else if (key.isAltKey()) {
      this.modifierKeys.alt = isDown;
    } else if (key.isCtrlKey()) {
      this.modifierKeys.ctrl = isDown;
    }
  }

}
