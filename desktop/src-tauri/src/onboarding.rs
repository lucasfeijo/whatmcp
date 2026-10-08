use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all="camelCase")]
pub struct Onboarding {
    pub version: u8,
    pub choice: String,
    pub step: u8,
    pub complete: bool,
    pub mode: String,
    pub folder: Option<String>,
    #[serde(skip)]
    pub warning: Option<String>,
}
impl Default for Onboarding {
    fn default()->Self {Self{version:1,choice:"welcome".into(),step:0,complete:false,mode:"demo".into(),folder:None,warning:None}}
}
impl Onboarding {
    pub fn load(data:&Path)->Self {
        let file=data.join("desktop-state.json");
        if !file.exists(){return Self::default()}
        let parsed=fs::read(&file).ok().filter(|bytes|bytes.len()<=65536).and_then(|bytes|serde_json::from_slice::<Self>(&bytes).ok());
        match parsed {
            Some(state) if state.version==1 && ["welcome","demo","setup","ready"].contains(&state.choice.as_str()) && ["demo","archive","existing"].contains(&state.mode.as_str()) && state.step<=3 && !(state.complete&&state.mode=="demo") => state,
            _=>Self{warning:Some("Não foi possível recuperar a configuração de abertura. Escolha seu arquivo novamente; seus dados foram preservados.".into()),..Self::default()},
        }
    }
    pub fn save(&self,data:&Path)->Result<(),String> {
        fs::create_dir_all(data).map_err(|e|e.to_string())?;
        let temp=data.join("desktop-state.tmp");
        let mut options=fs::OpenOptions::new();options.write(true).create_new(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        // A leftover temporary file from a crash never replaces the saved state.
        if temp.exists(){fs::remove_file(&temp).map_err(|e|e.to_string())?;}
        let result=(||{let mut file=options.open(&temp).map_err(|e|e.to_string())?;file.write_all(&serde_json::to_vec(self).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;fs::rename(&temp,data.join("desktop-state.json")).map_err(|e|e.to_string())})();
        if result.is_err(){let _=fs::remove_file(&temp);}result
    }
    pub fn selected(&self,data:&Path)->Result<(String,PathBuf),String> {
        let root=match self.mode.as_str(){
            "demo"|"archive"=>data.join("profiles").join(&self.mode),
            "existing"=>{let path=PathBuf::from(self.folder.as_deref().ok_or("Pasta do arquivo não configurada")?);if !path.is_absolute()||!path.join("config.json").is_file(){return Err("O arquivo selecionado não está disponível. Selecione sua pasta novamente.".into())}path},
            _=>return Err("Perfil inválido".into()),
        };Ok((self.mode.clone(),root))
    }
    pub fn profile(&mut self,mode:&str,root:&Path){
        self.mode=mode.into();self.folder=if mode=="existing"{Some(root.to_string_lossy().into_owned())}else{None};self.warning=None;
        if self.choice!="setup" {self.choice=if mode=="demo"{"demo"}else{"ready"}.into();self.complete=mode!="demo";}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn data()->PathBuf {let path=std::env::temp_dir().join(format!("whatmcp-onboarding-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(&path).unwrap();path}
    #[test] fn first_open_is_a_choice(){let root=data();let state=Onboarding::load(&root);assert_eq!(state.choice,"welcome");assert!(!state.complete);assert_eq!(state.selected(&root).unwrap().0,"demo");}
    #[test] fn demo_and_setup_progress_survive_restart(){let root=data();let mut state=Onboarding::default();state.profile("demo",&root);state.save(&root).unwrap();assert_eq!(Onboarding::load(&root).choice,"demo");state.choice="setup".into();state.step=2;state.profile("archive",&root);state.save(&root).unwrap();let loaded=Onboarding::load(&root);assert_eq!(loaded.choice,"setup");assert_eq!(loaded.step,2);assert!(!loaded.complete);assert_eq!(loaded.selected(&root).unwrap().1,root.join("profiles/archive"));}
    #[test] fn existing_selection_survives_and_missing_profile_is_rejected(){let root=data();let profile=root.join("fixture");fs::create_dir(&profile).unwrap();fs::write(profile.join("config.json"),"{}").unwrap();let mut state=Onboarding::default();state.profile("existing",&profile);state.save(&root).unwrap();let loaded=Onboarding::load(&root);assert!(loaded.complete);assert_eq!(loaded.selected(&root).unwrap().1,profile);fs::remove_file(profile.join("config.json")).unwrap();assert!(loaded.selected(&root).is_err());}
    #[test] fn invalid_state_returns_welcome_without_deleting_archives(){let root=data();fs::write(root.join("archive-marker"),"preserve").unwrap();fs::write(root.join("desktop-state.json"),"{broken").unwrap();let state=Onboarding::load(&root);assert_eq!(state.choice,"welcome");assert!(state.warning.is_some());assert_eq!(fs::read_to_string(root.join("archive-marker")).unwrap(),"preserve");}
    #[test] fn state_contains_no_configuration_or_secrets(){let root=data();let state=Onboarding::default();state.save(&root).unwrap();let saved=fs::read_to_string(root.join("desktop-state.json")).unwrap();assert!(!saved.contains("api_key"));#[cfg(unix)] {use std::os::unix::fs::PermissionsExt;assert_eq!(fs::metadata(root.join("desktop-state.json")).unwrap().permissions().mode()&0o777,0o600);}}
}
