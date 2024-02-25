import hljs from 'highlight.js'; // https://highlightjs.org
import markdownit from 'markdown-it';

const vscode = acquireVsCodeApi();

let model = "gpt-3.5-turbo";
let verbosity = "normal";

const TEXT_AREA = `
    <textarea class="vscode chat-input-field" cols="20" resize="vertical" style="width:100%"></textarea>
    <a class="vscode selection" data-command="toggle">+ Selection</a>
    <select class="vscode verbosity">
      <option value="code">code</option>
      <option value="concise">concise</option>
      <option value="normal" selected>normal</option>
      <option value="full">full</option>
    </select>
    <select class="vscode model">
      <option value="gpt-3.5-turbo" selected>GPT-3.5 Turbo</option>
      <option value="gpt-4">GPT-4</option>
    </select>
    <button style="margin-left:auto;" class="vscode primary" data-command="send" data-chatid="new"><i class='codicon--send'></i></button>`;
const DIV_INPUT_TEMPLATE = `
    <div class="chat-input">
    <h2 class="title"><i class="icon you"></i>You</h2>
    ${TEXT_AREA}
    </div>`;
const DIV_TEMPLATE = `
    <div class="chat-thinking" style="display:none">
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path fill="currentColor" d="M12,1A11,11,0,1,0,23,12,11,11,0,0,0,12,1Zm0,20a9,9,0,1,1,9-9A9,9,0,0,1,12,21Z" transform="matrix(0 0 0 0 12 12)"><animateTransform id="svgSpinnersPulseRingsMultiple0" attributeName="transform" begin="0;svgSpinnersPulseRingsMultiple2.end" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" type="translate" values="12 12;0 0"/><animateTransform additive="sum" attributeName="transform" begin="0;svgSpinnersPulseRingsMultiple2.end" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" type="scale" values="0;1"/><animate attributeName="opacity" begin="0;svgSpinnersPulseRingsMultiple2.end" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" values="1;0"/></path><path fill="currentColor" d="M12,1A11,11,0,1,0,23,12,11,11,0,0,0,12,1Zm0,20a9,9,0,1,1,9-9A9,9,0,0,1,12,21Z" transform="matrix(0 0 0 0 12 12)"><animateTransform id="svgSpinnersPulseRingsMultiple1" attributeName="transform" begin="svgSpinnersPulseRingsMultiple0.begin+0.2s" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" type="translate" values="12 12;0 0"/><animateTransform additive="sum" attributeName="transform" begin="svgSpinnersPulseRingsMultiple0.begin+0.2s" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" type="scale" values="0;1"/><animate attributeName="opacity" begin="svgSpinnersPulseRingsMultiple0.begin+0.2s" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" values="1;0"/></path><path fill="currentColor" d="M12,1A11,11,0,1,0,23,12,11,11,0,0,0,12,1Zm0,20a9,9,0,1,1,9-9A9,9,0,0,1,12,21Z" transform="matrix(0 0 0 0 12 12)"><animateTransform id="svgSpinnersPulseRingsMultiple2" attributeName="transform" begin="svgSpinnersPulseRingsMultiple0.begin+0.4s" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" type="translate" values="12 12;0 0"/><animateTransform additive="sum" attributeName="transform" begin="svgSpinnersPulseRingsMultiple0.begin+0.4s" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" type="scale" values="0;1"/><animate attributeName="opacity" begin="svgSpinnersPulseRingsMultiple0.begin+0.4s" calcMode="spline" dur="1.2s" keySplines=".52,.6,.25,.99" values="1;0"/></path></svg>
    <span style="margin: auto 4px">thinking</span>
    <button class="vscode secondary" data-command="cancel" style='margin-left:auto'>cancel</button>
    </div>
    <div class="bottom"></div>`;

// Actual default values
const md = markdownit({
  highlight: function (str, lang) {
    let code = undefined;
    if (lang && hljs.getLanguage(lang)) {
      try {
        code = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch (__) { }
    }
    if (code === undefined) {
      code = md.utils.escapeHtml(str);
    }
    return '<div class="code">' +
      '<code-head>' +
      '<a class="vscode" data-command="copy-code"><i class="codicon--copy"></i> <span>copy</span></a>' +
      '<a class="vscode" data-command="insert-code"><i class="codicon--insert"></i> <span>insert</span></a>' +
      '<a class="vscode" data-command="new-code" data-lang="' + lang + '"><i class="codicon--new-file"></i> <span>new</span></a>' +
      '</code-head>' +
      '<pre><code class="hljs">' + code + '</code></pre></div>';
  }
});

function scroll_down(div_element: Element) {
  window.setTimeout(() => {
    const bottom = div_element.querySelector('div.bottom');
    bottom?.scrollIntoView({ behavior: "smooth" });
  }, 20);
}

let conversations: { [index: number]: Element | undefined; } = {};

function get_conversation(conversation_id: number) {
  let div_element = conversations[1 * conversation_id];
  if (!div_element) {
    div_element = conversations[1 * conversation_id] = document.createElement('DIV');
    div_element.innerHTML = DIV_INPUT_TEMPLATE + DIV_TEMPLATE;
    const dd = div_element.querySelector("div.chat-input");
    dd.dataset['conversation_id'] = "" + conversation_id;
    dd.dataset['nr'] = "new";
  }
  return div_element;
}

function close_conversation(conversation_id: number) {
  const div_element = conversations[1 * conversation_id];
  if (div_element)
    div_element.remove();
  conversations[1 * conversation_id] = undefined;
}

function show_conversation(conversation_id: number) {
  const div_element = get_conversation(conversation_id);
  document.getElementById("root")?.replaceChildren(div_element);
}



function button_click(event: Event) {
  const button = event.target?.closest('button') || event.target?.closest('a');
  if (!button) return;
  const command = button.dataset['command'];
  switch (command) {
    case 'toggle':
      button.classList.toggle('selected');
      break;
    case 'send': {
      const div = button.parentNode;
      const text = div.querySelector('textarea').value;
      vscode.postMessage({
        type: "sendMessage",
        conversation_id: div.dataset['conversation_id'],
        chat_id: div.dataset['nr'],
        message: text,
        includeEditorSelection: !!div.querySelector("a.selection]")?.classList.contains('selected'),
        verbosity: div.querySelector("select.verbosity").value,
        model: div.querySelector("select.model").value,
      });
      break;
    }
    case 'edit':
    case 'close': {
      const div = button.parentNode.parentNode;
      add_conversation(
        div.dataset['conversation_id'],
        div.dataset['nr'],
        div.dataset['role'],
        div.dataset['content'],
        div.dataset['verbosity'],
        div.dataset['model'],
        command === "edit"
      );
      break;
    }
    case 'copy-code': {
      const code = button.parentElement.nextSibling.innerText;
      const bt = button.getElementsByTagName("span")[0];
      try {
        navigator.clipboard.writeText(code);
        bt.innerHTML = "copied";
        bt.style.color = "green";
      } catch (e) {
        bt.innerHTML = "failed";
        bt.style.color = "red";
        throw (e);
      }
      window.setTimeout(() => {
        bt.innerHTML = "copy";
        bt.style.color = "";
      }, 3000);
      break;
    }
    case 'insert-code': {
      const code = button.parentElement.nextSibling.innerText;
      vscode.postMessage({
        type: "editCode",
        value: code,
      });
      break;
    }
    case 'new-code': {
      const code = button.parentElement.nextSibling.innerText;
      vscode.postMessage({
        type: "openNew",
        value: code,
        // Handle HLJS language names that are different from VS Code's language IDs
        language: button.dataset.lang
          .replace("js", "javascript")
          .replace("py", "python")
          .replace("sh", "bash")
          .replace("ts", "typescript"),
      });
      break;
    }
  }
}


function add_conversation(conversation_id: number, nr: number, role: string, content: string, verbosity: string, model: string, edit: boolean) {
  const div_element = get_conversation(conversation_id);
  const role_icon = role == 'user' ? '<i class="codicon--account"></i>You' : '<i class="codicon--chatgpt"></i>ChatGPT';
  let edit_icon = '';
  if (role === "user") {
    const command = edit ? "close" : "edit";
    edit_icon = `<a class="vscode icon" style="margin-left:auto" appearance="icon" data-command="${command}"><i class="codicon--${command}"></i></a></h2>`;
  }
  let html_content = `<h2 class="title">${role_icon}${edit_icon}</h2>`;
  if (edit) {
    html_content += TEXT_AREA;
  } else {
    html_content += md.render(content);
  }
  html_content += "<vscode-divider></vscode-divider>";
  const divid = `chat${conversation_id}_${nr}`;
  let div = document.getElementById(divid);
  if (!div) {
    div = document.createElement('div');
    div.id = divid;
    let previous_div = undefined;
    for (const dd of div_element?.childNodes) {
      if (dd.tagName === "DIV") {
        const match = /chat\d+_(\d+)/.exec(dd.id);
        if (!match || match[1] * 1 > nr) {
          previous_div = dd;
          break;
        }
      }
    }
    div_element?.insertBefore(div, previous_div);
    scroll_down(div_element);
  }
  div.innerHTML = html_content;
  div.dataset['conversation_id'] = "" + conversation_id;
  div.dataset['nr'] = "" + nr;
  div.dataset['role'] = role;
  div.dataset['content'] = content;
  div.dataset['verbosity'] = verbosity;
  div.dataset['model'] = model;
  if (edit) {
    div.querySelector('textarea').value = content;
    div.querySelector("select.verbosity").value = verbosity;
    div.querySelector("select.model").value = model;
  }
}

function main() {
  document.addEventListener("click", button_click);
  vscode.postMessage({
    type: "refreshChat",
  });
}

function thinking(conversation_id: number) {
  const div_element = get_conversation(conversation_id);
  if (div_element) {
    div_element.querySelector("div.chat-input").style.display = "none";
    div_element.querySelector("div.chat-thinking").style.display = "flex";
    div_element.querySelector("textarea.chat-input-field").value = "";
    div_element.querySelector("a.selection").classList.toggle('selected', false);
    scroll_down(div_element);
  }
}

function finish(conversation_id: number) {
  const div_element = get_conversation(conversation_id);
  if (div_element) {
    div_element.querySelector("div.chat-input").style.display = "block";
    div_element.querySelector("div.chat-thinking").style.display = "none";
    scroll_down(div_element);
  }
}

function truncate(conversation_id: number, nr: number) {
  const div_element = get_conversation(conversation_id);
  const divs = div_element.childNodes;
  for (let i = divs.length - 1; i >= 0; i--) {
    const dd = divs[i];
    if (dd.tagName === "DIV") {
      const match = /chat\d+_(\d+)/.exec(dd.id);
      if (match && match[1] * 1 >= nr) {
        dd.remove();
      }
    }
  }
}

window.addEventListener("message", (event) => {
  console.log(event);
  const command = event.data.type;

  switch (command) {
    case "truncate":
      truncate(event.data.conversationId, event.data.nr);
      break;
    case "addChatMessage":
      add_conversation(event.data.conversationId, event.data.nr, event.data.role, event.data.content, event.data.verbosity, event.data.model, false);
      break;
    case "showInProgress":
      if (event.data.inProgress) {
        thinking(event.data.conversationId);
      } else {
        finish(event.data.conversationId);
      }
      break;
    case "showConversation":
      show_conversation(event.data.conversationId);
      break;
    case "closeConversation":
      close_conversation(event.data.conversationId);
      break;
    case "updateSettings":
      model = event.data.model;
      verbosity = event.data.verbosity;
      document.querySelector("div.chat-input select.verbosity").value = verbosity;
      document.querySelector("div.chat-input select.model").value = model;
  }
});

window.addEventListener("load", main);
