import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Model } from "../types";


export interface AppState {
  debug: boolean;
  extensionSettings: any;
  chatGPTModels: Model[];
  translations: any;
  useEditorSelection: boolean;
}

const initialState: AppState = {
  debug: false,
  extensionSettings: {},
  chatGPTModels: [],
  translations: {},
  useEditorSelection: false,
};

export const appSlice = createSlice({
  name: 'conversations',
  initialState,
  reducers: {
    setDebug: (state, action: PayloadAction<boolean>) => {
      state.debug = action.payload;
    },
    setExtensionSettings: (state, action: PayloadAction<{
      newSettings: any;
    }>) => {
      state.extensionSettings = action.payload.newSettings;
    },
    setChatGPTModels: (state, action: PayloadAction<{
      models: Model[];
    }>) => {
      state.chatGPTModels = action.payload.models;
    },
    setTranslations: (state, action: PayloadAction<any>) => {
      state.translations = action.payload;
    },
    setUseEditorSelection: (state, action: PayloadAction<boolean>) => {
      state.useEditorSelection = action.payload;
    }
  },
});

export const {
  setDebug,
  setExtensionSettings,
  setChatGPTModels,
  setTranslations,
  setUseEditorSelection,
} = appSlice.actions;

export default appSlice.reducer;